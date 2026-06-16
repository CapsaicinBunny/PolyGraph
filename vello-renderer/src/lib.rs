// Vello (Rust→WASM, WebGPU) vector renderer for the TS Module Scanner graph.
// Renders cards + edges + GPU vector text, with a camera (pan/zoom), picking, and
// selection/search highlighting. Everything is vector and crisp at any zoom.

use serde::Deserialize;
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

// Light cards on a charcoal canvas (matches the original React Flow look).
const CARD_FILL: Color = Color::from_rgb8(248, 250, 252);
const CARD_BORDER: Color = Color::from_rgb8(226, 232, 240);
const SELECT: Color = Color::from_rgb8(37, 99, 235);
const MATCH: Color = Color::from_rgb8(234, 179, 8);
const LABEL: Color = Color::from_rgb8(30, 41, 59);
const BADGE: Color = Color::from_rgb8(100, 116, 139);
const BASE: Color = Color::from_rgb8(21, 23, 28);

const FONT_SIZE: f32 = 13.0;
const GLYPH_SIZE: f32 = 13.0;
const LABEL_MIN_SCALE: f64 = 0.5; // only lay out labels/icons when readable
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
}

#[derive(Deserialize, Default)]
struct EdgeData {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    color: [u8; 3],
}

#[derive(Deserialize, Default)]
struct SceneData {
    nodes: Vec<NodeData>,
    edges: Vec<EdgeData>,
}

#[wasm_bindgen]
pub struct VelloCanvas {
    context: RenderContext,
    surface: RenderSurface<'static>,
    renderer: Renderer,
    scene: Scene,
    font: FontData,
    data: SceneData,
    cam_x: f64,
    cam_y: f64,
    cam_scale: f64,
    vw: f64,
    vh: f64,
    selected: Option<String>,
    search: String,
    dash_phase: f64,
}

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

        Ok(VelloCanvas {
            context,
            surface,
            renderer,
            scene: Scene::new(),
            font,
            data: SceneData::default(),
            cam_x: 0.0,
            cam_y: 0.0,
            cam_scale: 1.0,
            vw: width as f64,
            vh: height as f64,
            selected: None,
            search: String::new(),
            dash_phase: 0.0,
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
        self.cam_scale = scale.clamp(0.02, 4.0);
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
        self.cam_scale = scale.clamp(0.02, 4.0);
        self.cam_x = self.vw / 2.0 - (min_x + max_x) / 2.0 * self.cam_scale;
        self.cam_y = self.vh / 2.0 - (min_y + max_y) / 2.0 * self.cam_scale;
        vec![self.cam_x, self.cam_y, self.cam_scale]
    }

    /// Return the id of the topmost node under a screen point, if any.
    pub fn pick(&self, px: f64, py: f64) -> Option<String> {
        let wx = (px - self.cam_x) / self.cam_scale;
        let wy = (py - self.cam_y) / self.cam_scale;
        for n in self.data.nodes.iter().rev() {
            if wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h {
                return Some(n.id.clone());
            }
        }
        None
    }

    pub fn render(&mut self) -> Result<(), JsValue> {
        self.scene.reset();
        let camera = self.camera();
        let font_ref =
            FontRef::new(FONT_BYTES).map_err(|e| JsValue::from_str(&format!("font: {e}")))?;
        let charmap = font_ref.charmap();
        let metrics = font_ref.glyph_metrics(Size::new(GLYPH_SIZE), LocationRef::default());

        // Visible world bounds (with margin) for culling.
        let left = -self.cam_x / self.cam_scale;
        let top = -self.cam_y / self.cam_scale;
        let right = left + self.vw / self.cam_scale;
        let bottom = top + self.vh / self.cam_scale;
        let on_screen = |x: f64, y: f64, w: f64, h: f64| -> bool {
            x + w >= left && x <= right && y + h >= top && y <= bottom
        };

        // Edges first (under the cards). Drawn in screen space so line width and
        // dash size stay constant at any zoom; curved + animated marching ants.
        // Each segment is clipped to a padded viewport BEFORE dashing — an
        // off-screen endpoint at high zoom would otherwise yield a multi-million
        // pixel line and dashing it would exhaust the wasm allocator.
        let dash = Stroke::new(1.4).with_dashes(self.dash_phase, [6.0, 6.0]);
        const PAD: f64 = 120.0;
        let (cx, cy, cs) = (self.cam_x, self.cam_y, self.cam_scale);
        for e in &self.data.edges {
            let (ax, ay) = (e.x1 * cs + cx, e.y1 * cs + cy);
            let (bx, by) = (e.x2 * cs + cx, e.y2 * cs + cy);
            let Some((sx1, sy1, sx2, sy2)) =
                clip_segment(ax, ay, bx, by, -PAD, -PAD, self.vw + PAD, self.vh + PAD)
            else {
                continue;
            };
            let dx = sx2 - sx1;
            let dy = sy2 - sy1;
            // Smooth S-curve: pull control points along the dominant axis (like React Flow).
            let (c1, c2) = if dx.abs() >= dy.abs() {
                let mid = sx1 + dx * 0.5;
                (Point::new(mid, sy1), Point::new(mid, sy2))
            } else {
                let mid = sy1 + dy * 0.5;
                (Point::new(sx1, mid), Point::new(sx2, mid))
            };
            let curve = CubicBez::new(Point::new(sx1, sy1), c1, c2, Point::new(sx2, sy2));
            let color = Color::from_rgb8(e.color[0], e.color[1], e.color[2]);
            self.scene
                .stroke(&dash, Affine::IDENTITY, color, None, &curve);
        }

        let label_lod = self.cam_scale >= LABEL_MIN_SCALE;
        let searching = !self.search.is_empty();

        for n in &self.data.nodes {
            if !on_screen(n.x, n.y, n.w, n.h) {
                continue;
            }
            let accent = Color::from_rgb8(n.color[0], n.color[1], n.color[2]);
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
                .fill(Fill::NonZero, camera, CARD_FILL, None, &body);
            let border = if selected { SELECT } else { CARD_BORDER };
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

            // Icon chip (Chakra-style): a rounded square tinted with the accent color,
            // holding the kind's vector icon.
            let mid_y = n.y + n.h / 2.0;
            let chip_cx = n.x + 19.0;
            let chip = RoundedRect::new(
                chip_cx - 11.0,
                mid_y - 11.0,
                chip_cx + 11.0,
                mid_y + 11.0,
                6.0,
            );
            self.scene
                .fill(Fill::NonZero, camera, tint(n.color), None, &chip);
            draw_icon(
                &mut self.scene,
                camera,
                &n.shape,
                chip_cx,
                mid_y,
                ICON_R,
                accent,
            );

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

        let device_handle = &self.context.devices[self.surface.dev_id];
        self.renderer
            .render_to_texture(
                &device_handle.device,
                &device_handle.queue,
                &self.scene,
                &self.surface.target_view,
                &vello::RenderParams {
                    base_color: BASE,
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
