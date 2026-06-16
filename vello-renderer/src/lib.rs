// Phase 1 proof-of-concept: initialize Vello on a WebGPU <canvas> and render a
// vector scene (a rounded card). Later phases add edges, text, camera, and picking.

use vello::kurbo::{Affine, Point, RoundedRect, Stroke};
use vello::peniko::Color;
use vello::util::{RenderContext, RenderSurface};
use vello::{AaConfig, Renderer, RendererOptions, Scene};
use vello::wgpu;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct VelloCanvas {
    context: RenderContext,
    renderer: Renderer,
    surface: RenderSurface<'static>,
    scene: Scene,
}

#[wasm_bindgen]
impl VelloCanvas {
    /// Initialize a WebGPU device + surface for the given canvas and create a Vello renderer.
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
                surface_format: Some(surface.format),
                use_cpu: false,
                antialiasing_support: vello::AaSupport::area_only(),
                num_init_threads: None,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Renderer::new failed: {e}")))?;

        Ok(VelloCanvas {
            context,
            renderer,
            surface,
            scene: Scene::new(),
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.context
            .resize_surface(&mut self.surface, width.max(1), height.max(1));
    }

    /// POC render: clear + a single rounded card with a border.
    pub fn render(&mut self) -> Result<(), JsValue> {
        self.scene.reset();

        let card = RoundedRect::new(40.0, 40.0, 240.0, 96.0, 8.0);
        self.scene
            .fill(vello::peniko::Fill::NonZero, Affine::IDENTITY, Color::rgb8(28, 31, 38), None, &card);
        self.scene.stroke(
            &Stroke::new(1.5),
            Affine::IDENTITY,
            Color::rgb8(96, 165, 250),
            None,
            &card,
        );
        // Left accent bar.
        let accent = RoundedRect::new(40.0, 40.0, 46.0, 96.0, 3.0);
        self.scene
            .fill(vello::peniko::Fill::NonZero, Affine::IDENTITY, Color::rgb8(96, 165, 250), None, &accent);

        let device = &self.context.devices[self.surface.dev_id];
        let surface_texture = self
            .surface
            .surface
            .get_current_texture()
            .map_err(|e| JsValue::from_str(&format!("get_current_texture failed: {e}")))?;

        self.renderer
            .render_to_surface(
                &device.device,
                &device.queue,
                &self.scene,
                &surface_texture,
                &vello::RenderParams {
                    base_color: Color::rgb8(21, 23, 28),
                    width: self.surface.config.width,
                    height: self.surface.config.height,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|e| JsValue::from_str(&format!("render failed: {e}")))?;

        surface_texture.present();
        let _ = Point::ZERO; // keep kurbo Point import used as the API expands
        Ok(())
    }
}
