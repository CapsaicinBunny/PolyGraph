// Vello (Rust→WASM, WebGPU) vector renderer for the PolyGraph node graph.
// Renders cards + edges + GPU vector text, with a camera (pan/zoom), picking, and
// selection/search highlighting. Everything is vector and crisp at any zoom.

use serde::{Deserialize, Serialize};
use skrifa::instance::{LocationRef, Size};
use skrifa::{FontRef, MetadataProvider};
use vello::kurbo::{Affine, BezPath, Circle, CubicBez, Point, RoundedRect, Stroke};
use vello::peniko::{Blob, Color, Fill, FontData};
use vello::util::{RenderContext, RenderSurface};
use vello::wgpu;
use vello::{AaConfig, AaSupport, Glyph, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

const FONT_BYTES: &[u8] = include_bytes!("../assets/Inter-Regular.ttf");

// Accent / text colors shared by both themes (cards stay light-surfaced in both,
// so dark label/badge text reads on them either way).
const SELECT: Color = Color::from_rgb8(37, 99, 235);
const MATCH: Color = Color::from_rgb8(234, 179, 8);
const LABEL: Color = Color::from_rgb8(30, 41, 59);
const BADGE: Color = Color::from_rgb8(100, 116, 139);
const WHITE: Color = Color::from_rgb8(255, 255, 255);

// Dark theme: light cards on a charcoal canvas.
const BASE_DARK: Color = Color::from_rgb8(21, 23, 28);
const CARD_FILL_DARK: Color = Color::from_rgb8(248, 250, 252);
const CARD_BORDER_DARK: Color = Color::from_rgb8(226, 232, 240);

// Light theme: white cards on a soft slate canvas, with a more visible border.
const BASE_LIGHT: Color = Color::from_rgb8(237, 240, 245);
const CARD_FILL_LIGHT: Color = Color::from_rgb8(255, 255, 255);
const CARD_BORDER_LIGHT: Color = Color::from_rgb8(203, 213, 225);

const CLUSTER_HEADER_H: f64 = 26.0; // clickable header strip on each container (matches smart.ts HEADER_H)
const FONT_SIZE: f32 = 13.0;
const GLYPH_SIZE: f32 = 13.0;
const BADGE_SIZE: f32 = 9.0; // language-code text size inside file icons
const LABEL_MIN_SCALE: f64 = 0.5; // only lay out labels/icons when readable
const EDGE_DASH_BUDGET: usize = 300; // above this many *on-screen* edges, draw solid (dashing more overruns the allocator)
const EDGE_RENDER_CAP: usize = 60_000; // max edges encoded per frame; above this, sample a uniform subset (LOD)
// Zoomed-out render LOD: when the whole graph is on screen the cull can't drop
// anything, so a huge expanded scene (e.g. the kernel: ~29k nodes + ~56k edges)
// would draw everything every frame (~11fps). Below LABEL_MIN_SCALE we already hide
// labels/icons; also (a) draw each node as a single dot instead of a 3-op card, and
// (b) sample far fewer edges — individual cards/edges are imperceptible at that
// zoom, so detail is no loss but throughput jumps.
const EDGE_RENDER_CAP_LOD: usize = 8_000; // edge cap when zoomed out (below LABEL_MIN_SCALE)
const DOT_LOD_PX: f64 = 7.0; // below this on-screen card height, draw a dot, not a card
const ICON_R: f64 = 6.0; // icon half-size in world units

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[derive(Deserialize, Default)]
struct NodeData {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    /// Accent color (border / glyph / left bar) as [r,g,b].
    color: [u8; 3],
    label: String,
    #[serde(default)]
    shape: String,
    #[serde(default)]
    badge: String,
    /// Language code shown inside a file node's icon (e.g. "TS", "RS"); empty otherwise.
    #[serde(default)]
    lang: String,
    /// Brand color for the language badge, as [r,g,b].
    #[serde(default)]
    lang_color: [u8; 3],
}

#[derive(Deserialize, Default)]
struct EdgeData {
    #[serde(default)]
    id: String,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    color: [u8; 3],
    /// Aggregated occurrence count for this relationship (1 when not aggregated).
    /// Drives edge thickness and the `×N` multiplicity label.
    #[serde(default)]
    count: u32,
}

#[derive(Deserialize, Default)]
struct ClusterData {
    #[serde(default)]
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default)]
    depth: u32,
    #[serde(default)]
    label: String,
    /// Categorical color for the box (by directory/group), as [r,g,b]. [0,0,0] = use
    /// the neutral slate tint.
    #[serde(default)]
    color: [u8; 3],
}

#[derive(Deserialize, Default)]
struct SceneData {
    nodes: Vec<NodeData>,
    edges: Vec<EdgeData>,
    #[serde(default)]
    clusters: Vec<ClusterData>,
    #[serde(default)]
    routing: String,
}

/// Per-frame render counts exposed to JS telemetry (frame timing is measured
/// JS-side, since these counts are the part JS can't observe).
#[derive(Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct RenderStats {
    nodes_total: usize,
    nodes_drawn: usize,
    nodes_culled: usize,
    edges_total: usize,
    edges_encoded: usize,
    clusters_total: usize,
    clusters_drawn: usize,
}

#[wasm_bindgen]
pub struct VelloCanvas {
    context: RenderContext,
    surface: RenderSurface<'static>,
    renderer: Renderer,
    scene: Scene,
    font: FontData,
    /// Parsed font table directory, built once. Re-parsing it every frame (skrifa
    /// `FontRef::new`) is wasted work that adds up when many labels are drawn.
    font_ref: FontRef<'static>,
    data: SceneData,
    /// Counts from the last render(), read by JS via stats().
    last_stats: RenderStats,
    cam_x: f64,
    cam_y: f64,
    cam_scale: f64,
    vw: f64,
    vh: f64,
    selected: Option<String>,
    search: String,
    dash_phase: f64,
    dark: bool,
    /// Smallest allowed camera scale for the current scene. Tracks `fit()` so a graph
    /// too large to fit above the usual floor can still be zoomed all the way out.
    min_scale: f64,
}

const ZOOM_MAX: f64 = 4.0;
// Normal zoom-out floor for graphs that already fit above it (keeps small graphs from
// zooming out into empty space). Big graphs get a lower floor from `fit()` (see min_scale).
const ZOOM_OUT_FLOOR: f64 = 0.02;
// Absolute floor for the computed fit scale — only guards against zero/degenerate content.
const FIT_HARD_FLOOR: f64 = 0.0001;

#[wasm_bindgen]
impl VelloCanvas {
    pub async fn create(canvas: HtmlCanvasElement) -> Result<VelloCanvas, JsValue> {
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);

        let mut context = RenderContext::new();
        let surface = context
            .create_surface(
                wgpu::SurfaceTarget::Canvas(canvas),
                width,
                height,
                wgpu::PresentMode::AutoVsync,
            )
            .await
            .map_err(|e| JsValue::from_str(&format!("create_surface failed: {e}")))?;

        let renderer = Renderer::new(
            &context.devices[surface.dev_id].device,
            RendererOptions {
                use_cpu: false,
                antialiasing_support: AaSupport::area_only(),
                num_init_threads: None,
                pipeline_cache: None,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Renderer::new failed: {e}")))?;

        let font = FontData::new(Blob::new(std::sync::Arc::new(FONT_BYTES)), 0);
        let font_ref =
            FontRef::new(FONT_BYTES).map_err(|e| JsValue::from_str(&format!("font: {e}")))?;

        Ok(VelloCanvas {
            context,
            surface,
            renderer,
            scene: Scene::new(),
            font,
            font_ref,
            data: SceneData::default(),
            last_stats: RenderStats::default(),
            cam_x: 0.0,
            cam_y: 0.0,
            cam_scale: 1.0,
            vw: width as f64,
            vh: height as f64,
            selected: None,
            search: String::new(),
            dash_phase: 0.0,
            dark: true,
            min_scale: ZOOM_OUT_FLOOR,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.vw = width.max(1) as f64;
        self.vh = height.max(1) as f64;
        self.context
            .resize_surface(&mut self.surface, width.max(1), height.max(1));
    }

    /// Replace the graph data (JSON: { nodes:[...], edges:[...] }).
    pub fn set_data(&mut self, json: &str) -> Result<(), JsValue> {
        self.data = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("bad scene json: {e}")))?;
        Ok(())
    }

    pub fn set_camera(&mut self, x: f64, y: f64, scale: f64) {
        self.cam_x = x;
        self.cam_y = y;
        self.cam_scale = scale.clamp(self.min_scale, ZOOM_MAX);
    }

    pub fn set_selection(&mut self, id: Option<String>) {
        self.selected = id;
    }

    pub fn set_search(&mut self, query: String) {
        self.search = query.to_lowercase();
    }

    /// Marching-ants dash offset (screen px), advanced by the animation loop.
    pub fn set_phase(&mut self, phase: f64) {
        self.dash_phase = phase;
    }

    /// Switch the canvas palette: `true` = dark (charcoal canvas, light cards),
    /// `false` = light (soft slate canvas, white cards). The caller re-renders.
    pub fn set_theme(&mut self, dark: bool) {
        self.dark = dark;
    }

    /// Camera (screen units): world point -> screen = world * scale + (cam_x, cam_y).
    fn camera(&self) -> Affine {
        Affine::translate((self.cam_x, self.cam_y)) * Affine::scale(self.cam_scale)
    }

    /// Fit all nodes into the viewport; returns [x, y, scale] for the caller to keep.
    pub fn fit(&mut self) -> Vec<f64> {
        if self.data.nodes.is_empty() {
            return vec![self.cam_x, self.cam_y, self.cam_scale];
        }
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for n in &self.data.nodes {
            min_x = min_x.min(n.x);
            min_y = min_y.min(n.y);
            max_x = max_x.max(n.x + n.w);
            max_y = max_y.max(n.y + n.h);
        }
        let content_w = (max_x - min_x).max(1.0);
        let content_h = (max_y - min_y).max(1.0);
        let scale = (self.vw / content_w).min(self.vh / content_h).min(1.5) * 0.9;
        // Fit may need to go below the normal zoom-out floor for very large graphs
        // (e.g. the fully-expanded symbol level), so only the hard floor applies here.
        self.cam_scale = scale.clamp(FIT_HARD_FLOOR, ZOOM_MAX);
        // Let the user zoom out to at least the fit scale; small graphs keep the normal floor.
        self.min_scale = self.cam_scale.min(ZOOM_OUT_FLOOR);
        self.cam_x = self.vw / 2.0 - (min_x + max_x) / 2.0 * self.cam_scale;
        self.cam_y = self.vh / 2.0 - (min_y + max_y) / 2.0 * self.cam_scale;
        vec![self.cam_x, self.cam_y, self.cam_scale]
    }

    /// Return what's under a screen point: a cluster header as `"cluster:<id>"`
    /// (deepest wins), else the topmost node id, else a nearby edge as `"edge:<id>"`,
    /// else None.
    pub fn pick(&self, px: f64, py: f64) -> Option<String> {
        let wx = (px - self.cam_x) / self.cam_scale;
        let wy = (py - self.cam_y) / self.cam_scale;
        // Cluster header strips (top band of each box) take priority over nodes.
        let mut header: Option<(u32, &str)> = None;
        for c in &self.data.clusters {
            if wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + CLUSTER_HEADER_H {
                if header.map_or(true, |(d, _)| c.depth >= d) {
                    header = Some((c.depth, &c.id));
                }
            }
        }
        if let Some((_, id)) = header {
            return Some(format!("cluster:{id}"));
        }
        for n in self.data.nodes.iter().rev() {
            if wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h {
                return Some(n.id.clone());
            }
        }
        // Edges last: hit within ~6 screen px of the straight center-to-center segment.
        let tol = 6.0 / self.cam_scale;
        let mut closest: Option<(f64, &str)> = None;
        for e in &self.data.edges {
            if e.id.is_empty() {
                continue;
            }
            let d = point_segment_dist(wx, wy, e.x1, e.y1, e.x2, e.y2);
            if d <= tol && closest.map_or(true, |(best, _)| d < best) {
                closest = Some((d, &e.id));
            }
        }
        closest.map(|(_, id)| format!("edge:{id}"))
    }

    /// Counts from the most recent render() as a JSON string (telemetry).
    pub fn stats(&self) -> String {
        serde_json::to_string(&self.last_stats).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn render(&mut self) -> Result<(), JsValue> {
        self.scene.reset();
        let camera = self.camera();
        let (base, card_fill, card_border) = if self.dark {
            (BASE_DARK, CARD_FILL_DARK, CARD_BORDER_DARK)
        } else {
            (BASE_LIGHT, CARD_FILL_LIGHT, CARD_BORDER_LIGHT)
        };
        let font_ref = &self.font_ref;
        let charmap = font_ref.charmap();
        let metrics = font_ref.glyph_metrics(Size::new(GLYPH_SIZE), LocationRef::default());
        let badge_metrics = font_ref.glyph_metrics(Size::new(BADGE_SIZE), LocationRef::default());

        // Visible world bounds (with margin) for culling.
        let left = -self.cam_x / self.cam_scale;
        let top = -self.cam_y / self.cam_scale;
        let right = left + self.vw / self.cam_scale;
        let bottom = top + self.vh / self.cam_scale;
        let on_screen = |x: f64, y: f64, w: f64, h: f64| -> bool {
            x + w >= left && x <= right && y + h >= top && y <= bottom
        };

        // Telemetry counts for this frame (read by JS via stats()).
        let mut stats = RenderStats {
            nodes_total: self.data.nodes.len(),
            edges_total: self.data.edges.len(),
            clusters_total: self.data.clusters.len(),
            ..Default::default()
        };

        // Package containers (Smart layout): under the edges + cards, parents first
        // so deeper boxes nest visibly on top. Faint depth-tinted fill blended over
        // the canvas + a thin border.
        {
            let mut clusters: Vec<&ClusterData> = self.data.clusters.iter().collect();
            clusters.sort_by_key(|c| c.depth);
            let border = if self.dark {
                Color::from_rgb8(51, 57, 68)
            } else {
                CARD_BORDER_LIGHT
            };
            // Theme-aware header text — the default LABEL is dark slate (for white
            // cards) and would vanish on the dark container fill in dark mode.
            let header_text = if self.dark {
                Color::from_rgb8(148, 163, 184)
            } else {
                Color::from_rgb8(71, 85, 105)
            };
            for c in &clusters {
                if !on_screen(c.x, c.y, c.w, c.h) {
                    continue;
                }
                stats.clusters_drawn += 1;
                // Low alpha so nested boxes layer into deeper panels. When the box carries
                // a categorical color (by directory/group), wash the fill + outline + label
                // in that hue; otherwise fall back to the neutral slate tint.
                let alpha = (0.05 + 0.03 * c.depth as f32).min(0.16);
                let colored = c.color != [0, 0, 0];
                let fill = if colored {
                    Color::new([
                        c.color[0] as f32 / 255.0,
                        c.color[1] as f32 / 255.0,
                        c.color[2] as f32 / 255.0,
                        alpha + 0.05,
                    ])
                } else if self.dark {
                    Color::new([148.0 / 255.0, 163.0 / 255.0, 184.0 / 255.0, alpha])
                } else {
                    Color::new([100.0 / 255.0, 116.0 / 255.0, 139.0 / 255.0, alpha])
                };
                let edge_color = if colored {
                    Color::from_rgb8(c.color[0], c.color[1], c.color[2])
                } else {
                    border
                };
                let label_color = if colored {
                    Color::from_rgb8(c.color[0], c.color[1], c.color[2])
                } else {
                    header_text
                };
                let rect = RoundedRect::new(c.x, c.y, c.x + c.w, c.y + c.h, 14.0);
                self.scene.fill(Fill::NonZero, camera, fill, None, &rect);
                self.scene.stroke(
                    &Stroke::new(if colored { 1.3 } else { 1.0 }),
                    camera,
                    edge_color,
                    None,
                    &rect,
                );

                if !c.label.is_empty() {
                    let mut gx = c.x + 10.0;
                    let baseline = c.y + 17.0;
                    let glyphs: Vec<Glyph> = c
                        .label
                        .chars()
                        .filter_map(|ch| {
                            let gid = charmap.map(ch)?;
                            let g = Glyph {
                                id: gid.to_u32(),
                                x: gx as f32,
                                y: baseline as f32,
                            };
                            gx += metrics.advance_width(gid).unwrap_or(0.0) as f64;
                            Some(g)
                        })
                        .collect();
                    self.scene
                        .draw_glyphs(&self.font)
                        .font_size(FONT_SIZE)
                        .transform(camera)
                        .brush(label_color)
                        .draw(Fill::NonZero, glyphs.into_iter());
                }
            }
        }

        // Edges first (under the cards). Drawn in screen space so line width and
        // dash size stay constant at any zoom; curved + animated marching ants.
        // Each segment is clipped to a padded viewport BEFORE dashing — an
        // off-screen endpoint at high zoom would otherwise yield a multi-million
        // pixel line and dashing it would exhaust the wasm allocator.
        const PAD: f64 = 120.0;
        let (cx, cy, cs) = (self.cam_x, self.cam_y, self.cam_scale);
        // Only draw the ×N multiplicity labels when zoomed in enough to read them.
        let show_counts = self.cam_scale >= LABEL_MIN_SCALE;
        // LOD: above the cap, encode only a uniform sample of edges. At fit-zoom of a
        // 100k-node repo the whole graph is on-screen, so clipping doesn't help — and
        // encoding hundreds of thousands of curves overruns the wasm scene allocator
        // (the proximate "fails to render" failure). Zoomed-in views clip to far fewer
        // than the cap, so the stride is invisible in practice.
        let edge_cap = if self.cam_scale < LABEL_MIN_SCALE {
            EDGE_RENDER_CAP_LOD
        } else {
            EDGE_RENDER_CAP
        };
        let edge_step = (self.data.edges.len() / edge_cap).max(1);
        // Marching-ants dashing tessellates each curve into many short segments; doing
        // it for too many edges at once overruns the wasm allocator (memory access out
        // of bounds). Tie it to the LOD instead of the whole graph's size: count how
        // many edges are actually on screen this frame — the same sample + clip the
        // draw loop below uses — and only animate when that's a readable handful, i.e.
        // when zoomed into detail. Zoomed out / dense views cross the budget and fall
        // back to solid strokes. The count early-exits at the budget so it stays cheap
        // even on a million-edge graph.
        let solid_mode = {
            let mut on_screen = 0usize;
            for (i, e) in self.data.edges.iter().enumerate() {
                if i % edge_step != 0 {
                    continue;
                }
                let (ax, ay) = (e.x1 * cs + cx, e.y1 * cs + cy);
                let (bx, by) = (e.x2 * cs + cx, e.y2 * cs + cy);
                if clip_segment(ax, ay, bx, by, -PAD, -PAD, self.vw + PAD, self.vh + PAD).is_some() {
                    on_screen += 1;
                    if on_screen > EDGE_DASH_BUDGET {
                        break;
                    }
                }
            }
            on_screen > EDGE_DASH_BUDGET
        };
        for (i, e) in self.data.edges.iter().enumerate() {
            if i % edge_step != 0 {
                continue;
            }
            let (ax, ay) = (e.x1 * cs + cx, e.y1 * cs + cy);
            let (bx, by) = (e.x2 * cs + cx, e.y2 * cs + cy);
            let Some((sx1, sy1, sx2, sy2)) =
                clip_segment(ax, ay, bx, by, -PAD, -PAD, self.vw + PAD, self.vh + PAD)
            else {
                continue;
            };
            stats.edges_encoded += 1;
            let dx = sx2 - sx1;
            let dy = sy2 - sy1;
            // Fade long-distance edges so a dense graph's local structure stays
            // legible: full opacity up to ~600 world units, easing to 0.3 by ~4000.
            let world_len = ((e.x2 - e.x1).powi(2) + (e.y2 - e.y1).powi(2)).sqrt();
            let fade = (1.0 - ((world_len - 600.0) / 3400.0).clamp(0.0, 1.0) * 0.7) as f32;
            let color = Color::new([
                e.color[0] as f32 / 255.0,
                e.color[1] as f32 / 255.0,
                e.color[2] as f32 / 255.0,
                fade,
            ]);
            // Thicker stroke for repeated relationships — log-scaled so a few very
            // heavy edges don't swamp the rest, and capped so it stays a line. In
            // solid_mode (too many edges on screen — see above) drop the marching-ants
            // dashes to avoid the allocator overrun.
            let count = e.count.max(1);
            let weight = (1.4 + (count as f64).ln() * 0.9).min(6.0);
            let stroke = if solid_mode {
                Stroke::new(weight)
            } else {
                Stroke::new(weight).with_dashes(self.dash_phase, [6.0, 6.0])
            };
            if self.data.routing == "orthogonal" {
                // Right-angle elbow: turn once on the dominant axis' midpoint.
                let mut path = BezPath::new();
                path.move_to((sx1, sy1));
                if dx.abs() >= dy.abs() {
                    let mx = (sx1 + sx2) * 0.5;
                    path.line_to((mx, sy1));
                    path.line_to((mx, sy2));
                } else {
                    let my = (sy1 + sy2) * 0.5;
                    path.line_to((sx1, my));
                    path.line_to((sx2, my));
                }
                path.line_to((sx2, sy2));
                self.scene
                    .stroke(&stroke, Affine::IDENTITY, color, None, &path);
            } else {
                // Smooth S-curve: pull control points along the dominant axis.
                let (c1, c2) = if dx.abs() >= dy.abs() {
                    let mid = sx1 + dx * 0.5;
                    (Point::new(mid, sy1), Point::new(mid, sy2))
                } else {
                    let mid = sy1 + dy * 0.5;
                    (Point::new(sx1, mid), Point::new(sx2, mid))
                };
                let curve = CubicBez::new(Point::new(sx1, sy1), c1, c2, Point::new(sx2, sy2));
                self.scene
                    .stroke(&stroke, Affine::IDENTITY, color, None, &curve);
            }

            // `×N` multiplicity label at the screen-space midpoint, on a small pill
            // so it reads over both edges and cards. Constant size (screen space).
            if count > 1 && show_counts {
                let mx = (sx1 + sx2) * 0.5;
                let my = (sy1 + sy2) * 0.5;
                let text = format!("\u{00d7}{count}");
                let tw: f64 = text
                    .chars()
                    .filter_map(|c| charmap.map(c))
                    .map(|gid| metrics.advance_width(gid).unwrap_or(0.0) as f64)
                    .sum();
                let pill = RoundedRect::new(mx - tw / 2.0 - 3.0, my - 8.0, mx + tw / 2.0 + 3.0, my + 8.0, 5.0);
                self.scene
                    .fill(Fill::NonZero, Affine::IDENTITY, card_fill, None, &pill);
                let mut gx = mx - tw / 2.0;
                let baseline = my + 4.0;
                let glyphs: Vec<Glyph> = text
                    .chars()
                    .filter_map(|c| {
                        let gid = charmap.map(c)?;
                        let g = Glyph { id: gid.to_u32(), x: gx as f32, y: baseline as f32 };
                        gx += metrics.advance_width(gid).unwrap_or(0.0) as f64;
                        Some(g)
                    })
                    .collect();
                self.scene
                    .draw_glyphs(&self.font)
                    .font_size(FONT_SIZE)
                    .transform(Affine::IDENTITY)
                    .brush(BADGE)
                    .draw(Fill::NonZero, glyphs.into_iter());
            }
        }

        let label_lod = self.cam_scale >= LABEL_MIN_SCALE;
        let searching = !self.search.is_empty();

        for n in &self.data.nodes {
            if !on_screen(n.x, n.y, n.w, n.h) {
                stats.nodes_culled += 1;
                continue;
            }
            stats.nodes_drawn += 1;
            let accent = Color::from_rgb8(n.color[0], n.color[1], n.color[2]);

            // Zoomed-out LOD: when this card is only a few pixels tall, draw it as a
            // single screen-space dot (one fill) instead of the 3-op card + chrome.
            // Imperceptible as a shape at that size, but a big throughput win when the
            // whole graph is on screen.
            if n.h * self.cam_scale < DOT_LOD_PX {
                let scx = (n.x + n.w / 2.0) * self.cam_scale + self.cam_x;
                let scy = (n.y + n.h / 2.0) * self.cam_scale + self.cam_y;
                let dot = RoundedRect::new(scx - 1.6, scy - 1.6, scx + 1.6, scy + 1.6, 1.6);
                self.scene.fill(Fill::NonZero, Affine::IDENTITY, accent, None, &dot);
                continue;
            }

            let selected = Some(&n.id) == self.selected.as_ref();
            let r = n.x + n.w;
            let b = n.y + n.h;

            // Clean rounded card with a thin colored left edge. Fill the whole card in
            // the accent, then overlay the body inset 3px on the left (same radius, so
            // it stays inside the card — the accent shows only as a hairline edge that
            // follows the rounded corners, no artifacts).
            let card = RoundedRect::new(n.x, n.y, r, b, 10.0);
            self.scene.fill(Fill::NonZero, camera, accent, None, &card);
            let body = RoundedRect::new(n.x + 3.0, n.y, r, b, 10.0);
            self.scene
                .fill(Fill::NonZero, camera, card_fill, None, &body);
            let border = if selected { SELECT } else { card_border };
            let stroke_w = if selected { 1.8 } else { 1.0 };
            self.scene
                .stroke(&Stroke::new(stroke_w), camera, border, None, &card);

            // Search-match outline.
            if searching && n.label.to_lowercase().contains(&self.search) {
                let hl = RoundedRect::new(n.x - 2.0, n.y - 2.0, r + 2.0, b + 2.0, 11.0);
                self.scene
                    .stroke(&Stroke::new(2.0), camera, MATCH, None, &hl);
            }

            if !label_lod {
                continue;
            }

            let mid_y = n.y + n.h / 2.0;
            let chip_cx = n.x + 19.0;
            if !n.lang.is_empty() {
                // File node: a colored document with the language code inside it.
                let lang_color =
                    Color::from_rgb8(n.lang_color[0], n.lang_color[1], n.lang_color[2]);
                draw_lang_badge(
                    &mut self.scene,
                    &self.font,
                    font_ref,
                    &badge_metrics,
                    camera,
                    chip_cx,
                    mid_y,
                    lang_color,
                    &n.lang,
                );
            } else {
                // Icon chip (Chakra-style): a rounded square tinted with the accent
                // color, holding the kind's vector icon.
                let chip =
                    RoundedRect::new(chip_cx - 11.0, mid_y - 11.0, chip_cx + 11.0, mid_y + 11.0, 6.0);
                self.scene
                    .fill(Fill::NonZero, camera, tint(n.color), None, &chip);
                draw_icon(&mut self.scene, camera, &n.shape, chip_cx, mid_y, ICON_R, accent);
            }

            // Filename label (dark), vertically centered, clipped to the card width.
            let baseline = mid_y + 4.0;
            let label_x = n.x + 38.0;
            let max_w = n.w - 48.0;
            let mut gx = label_x;
            let glyphs: Vec<Glyph> = n
                .label
                .chars()
                .filter_map(|c| {
                    if gx - label_x > max_w {
                        return None;
                    }
                    let gid = charmap.map(c)?;
                    let g = Glyph {
                        id: gid.to_u32(),
                        x: gx as f32,
                        y: baseline as f32,
                    };
                    gx += metrics.advance_width(gid).unwrap_or(0.0) as f64;
                    Some(g)
                })
                .collect();
            self.scene
                .draw_glyphs(&self.font)
                .font_size(FONT_SIZE)
                .transform(camera)
                .brush(LABEL)
                .draw(Fill::NonZero, glyphs.into_iter());

            // Symbol-count badge (muted), right after the label.
            if !n.badge.is_empty() {
                let mut bx = gx + 8.0;
                let badge_max = n.x + n.w - 10.0;
                let bglyphs: Vec<Glyph> = n
                    .badge
                    .chars()
                    .filter_map(|c| {
                        if bx > badge_max {
                            return None;
                        }
                        let gid = charmap.map(c)?;
                        let g = Glyph {
                            id: gid.to_u32(),
                            x: bx as f32,
                            y: baseline as f32,
                        };
                        bx += metrics.advance_width(gid).unwrap_or(0.0) as f64;
                        Some(g)
                    })
                    .collect();
                self.scene
                    .draw_glyphs(&self.font)
                    .font_size(FONT_SIZE)
                    .transform(camera)
                    .brush(BADGE)
                    .draw(Fill::NonZero, bglyphs.into_iter());
            }
        }

        self.last_stats = stats;

        let device_handle = &self.context.devices[self.surface.dev_id];
        self.renderer
            .render_to_texture(
                &device_handle.device,
                &device_handle.queue,
                &self.scene,
                &self.surface.target_view,
                &vello::RenderParams {
                    base_color: base,
                    width: self.surface.config.width,
                    height: self.surface.config.height,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|e| JsValue::from_str(&format!("render failed: {e}")))?;

        let frame = match self.surface.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            other => {
                return Err(JsValue::from_str(&format!(
                    "surface unavailable: {other:?}"
                )))
            }
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            device_handle
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("vello-blit"),
                });
        self.surface.blitter.copy(
            &device_handle.device,
            &mut encoder,
            &self.surface.target_view,
            &view,
        );
        device_handle.queue.submit([encoder.finish()]);
        frame.present();
        Ok(())
    }
}

/// Shortest distance from point (px,py) to the segment (x1,y1)-(x2,y2).
fn point_segment_dist(px: f64, py: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((px - x1) * dx + (py - y1) * dy) / len2).clamp(0.0, 1.0)
    };
    let cx = x1 + t * dx;
    let cy = y1 + t * dy;
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}

/// Liang–Barsky line clip to an axis-aligned rect. Returns the clipped segment, or
/// None if it lies entirely outside — bounds dash work to the visible viewport.
fn clip_segment(
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    minx: f64,
    miny: f64,
    maxx: f64,
    maxy: f64,
) -> Option<(f64, f64, f64, f64)> {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let p = [-dx, dx, -dy, dy];
    let q = [x0 - minx, maxx - x0, y0 - miny, maxy - y0];
    let mut t0 = 0.0_f64;
    let mut t1 = 1.0_f64;
    for i in 0..4 {
        if p[i] == 0.0 {
            if q[i] < 0.0 {
                return None; // parallel to this edge and outside it
            }
        } else {
            let r = q[i] / p[i];
            if p[i] < 0.0 {
                if r > t1 {
                    return None;
                }
                if r > t0 {
                    t0 = r;
                }
            } else {
                if r < t0 {
                    return None;
                }
                if r < t1 {
                    t1 = r;
                }
            }
        }
    }
    Some((x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy))
}

/// A light tint of an accent color (mixed toward white) for the icon chip background.
fn tint(c: [u8; 3]) -> Color {
    let mix = |v: u8| ((v as f32) * 0.18 + 255.0 * 0.82) as u8;
    Color::from_rgb8(mix(c[0]), mix(c[1]), mix(c[2]))
}

/// Draw a file node's icon as a colored document with the language code inside.
#[allow(clippy::too_many_arguments)]
fn draw_lang_badge(
    scene: &mut Scene,
    font: &FontData,
    font_ref: &FontRef,
    metrics: &skrifa::metrics::GlyphMetrics<'_>,
    t: Affine,
    cx: f64,
    cy: f64,
    color: Color,
    code: &str,
) {
    // Document silhouette with a folded top-right corner, filled in the lang color.
    let w = 9.0;
    let h = 11.0;
    let mut p = BezPath::new();
    p.move_to((cx - w, cy - h));
    p.line_to((cx + w * 0.35, cy - h));
    p.line_to((cx + w, cy - h * 0.5));
    p.line_to((cx + w, cy + h));
    p.line_to((cx - w, cy + h));
    p.close_path();
    scene.fill(Fill::NonZero, t, color, None, &p);

    // Two-letter language code, white, centered on the document.
    let charmap = font_ref.charmap();
    let width: f64 = code
        .chars()
        .filter_map(|c| charmap.map(c))
        .map(|gid| metrics.advance_width(gid).unwrap_or(0.0) as f64)
        .sum();
    let mut gx = cx - width / 2.0;
    let baseline = cy + 3.2;
    let glyphs: Vec<Glyph> = code
        .chars()
        .filter_map(|c| {
            let gid = charmap.map(c)?;
            let g = Glyph { id: gid.to_u32(), x: gx as f32, y: baseline as f32 };
            gx += metrics.advance_width(gid).unwrap_or(0.0) as f64;
            Some(g)
        })
        .collect();
    scene
        .draw_glyphs(font)
        .font_size(BADGE_SIZE)
        .transform(t)
        .brush(WHITE)
        .draw(Fill::NonZero, glyphs.into_iter());
}

/// Draw a small vector icon centered at (cx, cy) with half-size `r`, in `color`.
fn draw_icon(scene: &mut Scene, t: Affine, shape: &str, cx: f64, cy: f64, r: f64, color: Color) {
    match shape {
        "circle" => {
            scene.fill(
                Fill::NonZero,
                t,
                color,
                None,
                &Circle::new(Point::new(cx, cy), r),
            );
        }
        "square" => {
            let s = RoundedRect::new(cx - r, cy - r, cx + r, cy + r, 1.0);
            scene.fill(Fill::NonZero, t, color, None, &s);
        }
        "rounded" => {
            let s = RoundedRect::new(cx - r, cy - r, cx + r, cy + r, r * 0.5);
            scene.fill(Fill::NonZero, t, color, None, &s);
        }
        "diamond" => {
            scene.fill(Fill::NonZero, t, color, None, &diamond(cx, cy, r));
        }
        "diamond-o" => {
            scene.stroke(&Stroke::new(1.5), t, color, None, &diamond(cx, cy, r));
        }
        "hexagon" => {
            scene.fill(Fill::NonZero, t, color, None, &hexagon(cx, cy, r));
        }
        "bars" => {
            for i in -1..=1 {
                let yy = cy + i as f64 * (r * 0.7);
                let bar = RoundedRect::new(cx - r, yy - r * 0.16, cx + r, yy + r * 0.16, r * 0.16);
                scene.fill(Fill::NonZero, t, color, None, &bar);
            }
        }
        "arrow" => {
            let mut shaft = BezPath::new();
            shaft.move_to((cx - r, cy + r));
            shaft.line_to((cx + r, cy - r));
            scene.stroke(&Stroke::new(1.5), t, color, None, &shaft);
            let mut head = BezPath::new();
            head.move_to((cx + r * 0.1, cy - r));
            head.line_to((cx + r, cy - r));
            head.line_to((cx + r, cy - r * 0.1));
            scene.stroke(&Stroke::new(1.5), t, color, None, &head);
        }
        // "doc" (files) and any unknown shape: a page outline with a folded corner.
        _ => {
            let w = r * 1.3;
            let h = r * 1.7;
            let mut p = BezPath::new();
            p.move_to((cx - w, cy - h));
            p.line_to((cx + w * 0.35, cy - h));
            p.line_to((cx + w, cy - h * 0.5));
            p.line_to((cx + w, cy + h));
            p.line_to((cx - w, cy + h));
            p.close_path();
            scene.stroke(&Stroke::new(1.4), t, color, None, &p);
        }
    }
}

fn diamond(cx: f64, cy: f64, r: f64) -> BezPath {
    let mut p = BezPath::new();
    p.move_to((cx, cy - r));
    p.line_to((cx + r, cy));
    p.line_to((cx, cy + r));
    p.line_to((cx - r, cy));
    p.close_path();
    p
}

fn hexagon(cx: f64, cy: f64, r: f64) -> BezPath {
    let mut p = BezPath::new();
    for i in 0..6 {
        let a = std::f64::consts::FRAC_PI_3 * i as f64 - std::f64::consts::FRAC_PI_2;
        let pt = (cx + r * a.cos(), cy + r * a.sin());
        if i == 0 {
            p.move_to(pt);
        } else {
            p.line_to(pt);
        }
    }
    p.close_path();
    p
}
