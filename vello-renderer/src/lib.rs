// Vello (Rust→WASM, WebGPU) vector renderer for the TS Module Scanner graph.
// Renders cards + edges + GPU vector text, with a camera (pan/zoom), picking, and
// selection/search highlighting. Everything is vector and crisp at any zoom.

use serde::Deserialize;
use skrifa::instance::{LocationRef, Size};
use skrifa::{FontRef, MetadataProvider};
use vello::kurbo::{Affine, Line, Point, RoundedRect, Stroke};
use vello::peniko::{Blob, Color, Fill, FontData};
use vello::util::{RenderContext, RenderSurface};
use vello::wgpu;
use vello::{AaConfig, AaSupport, Glyph, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

const FONT_BYTES: &[u8] = include_bytes!("../assets/Inter-Regular.ttf");

const PANEL_FILL: Color = Color::from_rgb8(28, 31, 38);
const BORDER: Color = Color::from_rgb8(59, 65, 76);
const SELECT: Color = Color::from_rgb8(96, 165, 250);
const MATCH: Color = Color::from_rgb8(250, 204, 21);
const LABEL: Color = Color::from_rgb8(226, 232, 240);
const BASE: Color = Color::from_rgb8(21, 23, 28);

const FONT_SIZE: f32 = 13.0;
const GLYPH_SIZE: f32 = 13.0;
const LABEL_MIN_SCALE: f64 = 0.5; // only lay out labels when readable

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
    glyph: String,
    #[serde(default)]
    badge: String,
    #[serde(default)]
    external: bool,
}

#[derive(Deserialize, Default)]
struct EdgeData {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    color: [u8; 3],
    #[serde(default)]
    dashed: bool,
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
        self.data =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("bad scene json: {e}")))?;
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

    /// Camera (screen units): world point -> screen = world * scale + (cam_x, cam_y).
    fn camera(&self) -> Affine {
        Affine::translate((self.cam_x, self.cam_y)) * Affine::scale(self.cam_scale)
    }

    /// Fit all nodes into the viewport; returns [x, y, scale] for the caller to keep.
    pub fn fit(&mut self) -> Vec<f64> {
        if self.data.nodes.is_empty() {
            return vec![self.cam_x, self.cam_y, self.cam_scale];
        }
        let (mut min_x, mut min_y, mut max_x, mut max_y) =
            (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
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
        let font_ref = FontRef::new(FONT_BYTES).map_err(|e| JsValue::from_str(&format!("font: {e}")))?;
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

        // Edges first (under nodes).
        for e in &self.data.edges {
            if !on_screen(e.x1.min(e.x2), e.y1.min(e.y2), (e.x1 - e.x2).abs(), (e.y1 - e.y2).abs()) {
                continue;
            }
            let color = Color::from_rgb8(e.color[0], e.color[1], e.color[2]);
            let line = Line::new(Point::new(e.x1, e.y1), Point::new(e.x2, e.y2));
            self.scene
                .stroke(&Stroke::new(1.25), camera, color, None, &line);
        }

        let label_lod = self.cam_scale >= LABEL_MIN_SCALE;
        let searching = !self.search.is_empty();

        for n in &self.data.nodes {
            if !on_screen(n.x, n.y, n.w, n.h) {
                continue;
            }
            let accent = Color::from_rgb8(n.color[0], n.color[1], n.color[2]);
            let card = RoundedRect::new(n.x, n.y, n.x + n.w, n.y + n.h, 6.0);
            self.scene.fill(Fill::NonZero, camera, PANEL_FILL, None, &card);
            let border = if Some(&n.id) == self.selected.as_ref() {
                SELECT
            } else {
                BORDER
            };
            let stroke_w = if n.external { 1.0 } else { 1.2 };
            self.scene
                .stroke(&Stroke::new(stroke_w), camera, border, None, &card);
            // Left accent bar.
            let bar = RoundedRect::new(n.x, n.y, n.x + 4.0, n.y + n.h, 2.0);
            self.scene.fill(Fill::NonZero, camera, accent, None, &bar);

            // Search-match outline.
            if searching && n.label.to_lowercase().contains(&self.search) {
                let hl = RoundedRect::new(n.x - 2.0, n.y - 2.0, n.x + n.w + 2.0, n.y + n.h + 2.0, 7.0);
                self.scene.stroke(&Stroke::new(2.0), camera, MATCH, None, &hl);
            }

            if !label_lod {
                continue;
            }
            // Glyph + label text, vertically centered, clipped to the card width.
            let baseline = n.y + n.h / 2.0 + 4.0;
            let text = if n.badge.is_empty() {
                format!("{}  {}", n.glyph, n.label)
            } else {
                format!("{}  {}  {}", n.glyph, n.label, n.badge)
            };
            let max_w = n.w - 18.0;
            let mut gx = n.x + 12.0;
            let start = gx;
            let glyphs: Vec<Glyph> = text
                .chars()
                .filter_map(|c| {
                    if gx - start > max_w {
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
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            other => return Err(JsValue::from_str(&format!("surface unavailable: {other:?}"))),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = device_handle
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("vello-blit") });
        self.surface
            .blitter
            .copy(&device_handle.device, &mut encoder, &self.surface.target_view, &view);
        device_handle.queue.submit([encoder.finish()]);
        frame.present();
        Ok(())
    }
}
