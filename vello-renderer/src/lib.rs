// Phase 1 proof-of-concept: initialize Vello on a WebGPU <canvas> with explicit
// wgpu setup (clearer diagnostics than the bundled RenderContext) and render a card.

use vello::kurbo::{Affine, RoundedRect, Stroke};
use vello::peniko::{Color, Fill};
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
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    scene: Scene,
}

#[wasm_bindgen]
impl VelloCanvas {
    /// Initialize a WebGPU device + surface for the given canvas and create a Vello renderer.
    pub async fn create(canvas: HtmlCanvasElement) -> Result<VelloCanvas, JsValue> {
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });

        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsValue::from_str(&format!("create_surface failed: {e}")))?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await;
        let adapter = match adapter {
            Some(a) => a,
            None => {
                let any = instance
                    .request_adapter(&wgpu::RequestAdapterOptions::default())
                    .await;
                let hint = if any.is_some() {
                    "an adapter exists but none is compatible with the canvas surface"
                } else {
                    "navigator.gpu.requestAdapter() returned null — WebGPU may be disabled or the GPU blocklisted (try chrome://flags/#enable-unsafe-webgpu, or check chrome://gpu)"
                };
                return Err(JsValue::from_str(&format!("no WebGPU adapter: {hint}")));
            }
        };

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("vello-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults()
                        .using_resolution(adapter.limits()),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                None,
            )
            .await
            .map_err(|e| JsValue::from_str(&format!("request_device failed: {e}")))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        let renderer = Renderer::new(
            &device,
            RendererOptions {
                surface_format: Some(format),
                use_cpu: false,
                antialiasing_support: AaSupport::area_only(),
                num_init_threads: None,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Renderer::new failed: {e}")))?;

        Ok(VelloCanvas {
            device,
            queue,
            surface,
            config,
            renderer,
            scene: Scene::new(),
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
    }

    /// POC render: clear + a single rounded card with a border and left accent bar.
    pub fn render(&mut self) -> Result<(), JsValue> {
        self.scene.reset();

        let card = RoundedRect::new(40.0, 40.0, 240.0, 96.0, 8.0);
        self.scene
            .fill(Fill::NonZero, Affine::IDENTITY, Color::rgb8(28, 31, 38), None, &card);
        self.scene
            .stroke(&Stroke::new(1.5), Affine::IDENTITY, Color::rgb8(96, 165, 250), None, &card);
        let accent = RoundedRect::new(40.0, 40.0, 46.0, 96.0, 3.0);
        self.scene
            .fill(Fill::NonZero, Affine::IDENTITY, Color::rgb8(96, 165, 250), None, &accent);

        let frame = self
            .surface
            .get_current_texture()
            .map_err(|e| JsValue::from_str(&format!("get_current_texture failed: {e}")))?;

        self.renderer
            .render_to_surface(
                &self.device,
                &self.queue,
                &self.scene,
                &frame,
                &vello::RenderParams {
                    base_color: Color::rgb8(21, 23, 28),
                    width: self.config.width,
                    height: self.config.height,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|e| JsValue::from_str(&format!("render failed: {e}")))?;

        frame.present();
        Ok(())
    }
}
