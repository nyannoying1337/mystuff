package mcstatus;

import java.io.IOException;
import java.nio.file.Path;

import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.pipeline.TextureTarget;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.GpuTexture;
import net.minecraft.client.Minecraft;
import org.joml.Vector4f;

/**
 * Grabs a frame of the world without touching the game's own frame.
 *
 * <p>Vanilla screenshots read back the full frame and loop over every pixel on
 * the render thread; measured on Intel OpenGL at 854×480 that froze the game for
 * ~600 ms per capture. This runs right after the world is drawn (so before the
 * HUD and chat), scales it on the GPU to at most capture_width, and reads it
 * back with {@link GpuReadback}: about 1 ms on the render thread, the rest off it.
 */
final class FrameCapture {
	private static final int TIMINGS_LOGGED_AT_INFO = 3;

	private final Path file;
	private final ModConfig config;
	private TextureTarget scaled;
	private long nextCaptureAt = System.currentTimeMillis() + 10_000;
	private boolean requested;
	private boolean inFlight;
	private int captures;

	FrameCapture(Path file, ModConfig config) {
		this.file = file;
		this.config = config;
	}

	/** Capture on the next rendered frame, e.g. when the pause menu opens. */
	void requestSoon() {
		requested = true;
	}

	/** Render thread, after the level pass and before any GUI. */
	void onLevelRendered(Minecraft client) {
		long now = System.currentTimeMillis();
		if (inFlight || PanoramaCapture.isRendering() || client.level == null || client.player == null) return;
		// no frames from servers: other people's builds and names aren't ours to publish
		if (client.getSingleplayerServer() == null) return;
		if (!requested && now < nextCaptureAt) return;
		requested = false;
		nextCaptureAt = now + config.captureIntervalSeconds * 1000L;

		RenderTarget main = client.gameRenderer.mainRenderTarget();
		GpuTexture source = main.getColorTexture();
		if (source == null || main.width <= 0 || main.height <= 0) return;

		int width = Math.min(config.captureWidth, main.width);
		int height = Math.max(1, Math.round(main.height * (float) width / main.width));
		try {
			if (scaled == null || scaled.width != width || scaled.height != height) {
				if (scaled != null) scaled.destroyBuffers();
				scaled = new TextureTarget("mc-status capture", width, height, false, source.getFormat());
			}
			RenderSystem.getDevice().createCommandEncoder().clearColorTexture(scaled.getColorTexture(), new Vector4f(0, 0, 0, 1));
			main.blitAndBlendToTexture(scaled.getColorTextureView(), null);
			inFlight = GpuReadback.read(scaled.getColorTexture(), width, height, (image, timings) -> {
				Minecraft.getInstance().execute(() -> inFlight = false);
				if (image == null) return;
				String line = String.format("capture %dx%d: %.2f ms on the render thread, %.2f ms copying off it",
					width, height, timings.renderThreadMs(), timings.copyMs());
				if (captures++ < TIMINGS_LOGGED_AT_INFO) McStatusClient.LOG.info(line);
				else McStatusClient.LOG.debug(line);
				try (image) {
					AtomicFiles.write(file, image::writeToFile);
				} catch (IOException err) {
					McStatusClient.LOG.warn("could not write {}: {}", file, err.getMessage());
				}
			});
		} catch (RuntimeException err) {
			// e.g. mid-resize; the next interval tries again
			inFlight = false;
			McStatusClient.LOG.debug("skipped capture: {}", err.toString());
		}
	}
}
