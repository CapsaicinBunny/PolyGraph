// Phase 1 proof-of-concept (Vello 0.9 / wgpu 29): initialize Vello on a WebGPU
// <canvas> and render a vector card. Vello renders into an intermediate texture,
// which is then blitted to the surface.

use vello::kurbo::{Affine, RoundedRect, Stroke};
use vello::peniko::{Color, Fill};
use vello::util::{RenderContext, RenderSurface};
use vello::wgpu;
use vello::{AaConfig, AaSupport, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct VelloCanvas {
    context: RenderContext,
    surface: RenderSurface<'static>,
    renderer: Renderer,
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

        let device = &context.devices[surface.dev_id].device;
        let renderer = Renderer::new(
            device,
            RendererOptions {
                use_cpu: false,
                antialiasing_support: AaSupport::area_only(),
                num_init_threads: None,
                pipeline_cache: None,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Renderer::new failed: {e}")))?;

        Ok(VelloCanvas {
            context,
            surface,
            renderer,
            scene: Scene::new(),
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.context
            .resize_surface(&mut self.surface, width.max(1), height.max(1));
    }

    /// POC render: a single rounded card with a border and left accent bar.
    pub fn render(&mut self) -> Result<(), JsValue> {
        self.scene.reset();

        let card = RoundedRect::new(40.0, 40.0, 240.0, 96.0, 8.0);
        self.scene
            .fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(28, 31, 38), None, &card);
        self.scene.stroke(
            &Stroke::new(1.5),
            Affine::IDENTITY,
            Color::from_rgb8(96, 165, 250),
            None,
            &card,
        );
        let accent = RoundedRect::new(40.0, 40.0, 46.0, 96.0, 3.0);
        self.scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgb8(96, 165, 250),
            None,
            &accent,
        );

        let device_handle = &self.context.devices[self.surface.dev_id];
        self.renderer
            .render_to_texture(
                &device_handle.device,
                &device_handle.queue,
                &self.scene,
                &self.surface.target_view,
                &vello::RenderParams {
                    base_color: Color::from_rgb8(21, 23, 28),
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
