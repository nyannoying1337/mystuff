package mcstatus;

import java.io.IOException;
import java.nio.file.Path;

import com.mojang.blaze3d.buffers.GpuBuffer;
import com.mojang.blaze3d.buffers.GpuBufferSlice;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.pipeline.TextureTarget;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.CommandEncoder;
import com.mojang.blaze3d.systems.GpuDevice;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.GpuTexture;
import net.minecraft.client.Minecraft;
import net.minecraft.util.Util;
import org.joml.Vector4f;
import org.lwjgl.system.MemoryUtil;

/**
 * Grabs a small frame of the world without touching the game's own frame.
 *
 * <p>Vanilla screenshots read back the full-resolution frame and loop over every
 * pixel on the render thread; measured on Intel OpenGL at 854×480 that froze the
 * game for ~600 ms per capture. This runs right after the world is drawn (so
 * before the HUD and chat), shrinks it on the GPU into a ~640px texture, and
 * reads back only that. The render thread spends about 1 ms; copying, flipping,
 * alpha and PNG encoding happen on the io pool, with no visible frame spike.
 */
final class FrameCapture {
	private static final int TIMINGS_LOGGED_AT_INFO = 3;

	private final Path file;
	private final ModConfig config;
	private TextureTarget small;
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
		if (inFlight || client.level == null || client.player == null) return;
		// no frames from servers: other people's builds and names aren't ours to publish
		if (client.getSingleplayerServer() == null) return;
		if (!requested && now < nextCaptureAt) return;
		requested = false;
		nextCaptureAt = now + config.captureIntervalSeconds * 1000L;

		RenderTarget main = client.gameRenderer.mainRenderTarget();
		GpuTexture source = main.getColorTexture();
		if (source == null || main.width <= 0 || main.height <= 0) return;

		long started = System.nanoTime();
		int width = Math.min(config.captureWidth, main.width);
		int height = Math.max(1, Math.round(main.height * (float) width / main.width));
		try {
			if (small == null || small.width != width || small.height != height) {
				if (small != null) small.destroyBuffers();
				small = new TextureTarget("mc-status capture", width, height, false, source.getFormat());
			}
			GpuDevice device = RenderSystem.getDevice();
			CommandEncoder encoder = device.createCommandEncoder();
			GpuTexture target = small.getColorTexture();
			encoder.clearColorTexture(target, new Vector4f(0, 0, 0, 1));
			main.blitAndBlendToTexture(small.getColorTextureView(), null);

			int bytesPerPixel = target.getFormat().blockSize();
			if (bytesPerPixel != 4) {
				// the bulk copy assumes 8-bit RGBA, which is what the game uses
				McStatusClient.LOG.debug("skipped capture: unexpected format {}", target.getFormat());
				return;
			}
			GpuBuffer buffer = device.createBuffer(() -> "mc-status capture readback",
				GpuBuffer.USAGE_MAP_READ | GpuBuffer.USAGE_COPY_DST, (long) width * height * bytesPerPixel);
			inFlight = true;
			long issuedNs = System.nanoTime() - started;
			encoder.copyTextureToBuffer(target, buffer, 0L, () -> onReadback(buffer, width, height, bytesPerPixel, issuedNs), 0);
		} catch (RuntimeException err) {
			// e.g. mid-resize; the next interval tries again
			inFlight = false;
			McStatusClient.LOG.debug("skipped capture: {}", err.toString());
		}
	}

	/**
	 * Render thread, once the GPU copy is done. Only maps the buffer: on some
	 * drivers (Intel OpenGL for one) reading mapped memory is slow — about 40 ms
	 * for this small frame — so the actual copy happens on the io pool, and the
	 * buffer is unmapped back on the render thread afterwards.
	 */
	private void onReadback(GpuBuffer buffer, int width, int height, int bytesPerPixel, long issuedNs) {
		long started = System.nanoTime();
		GpuBufferSlice.MappedView view;
		try {
			view = buffer.map(true, false);
		} catch (RuntimeException err) {
			buffer.close();
			inFlight = false;
			McStatusClient.LOG.debug("capture map failed: {}", err.toString());
			return;
		}
		long mappedNs = System.nanoTime() - started;
		long address = MemoryUtil.memAddress(view.data());
		long bytes = (long) width * height * bytesPerPixel;
		Minecraft client = Minecraft.getInstance();

		Util.ioPool().execute(() -> {
			long copyStarted = System.nanoTime();
			NativeImage image = null;
			try {
				image = new NativeImage(width, height, false);
				// RGBA8 texture bytes are already in NativeImage's RGBA layout.
				MemoryUtil.memCopy(address, image.getPointer(), bytes);
			} catch (RuntimeException err) {
				if (image != null) image.close();
				image = null;
				McStatusClient.LOG.debug("capture copy failed: {}", err.toString());
			}
			long copyNs = System.nanoTime() - copyStarted;
			client.execute(() -> {
				view.close();
				buffer.close();
				inFlight = false;
			});

			String timings = String.format("capture %dx%d: %.2f ms issuing + %.2f ms mapping on render thread, %.2f ms copying off it",
				width, height, issuedNs / 1e6, mappedNs / 1e6, copyNs / 1e6);
			if (captures++ < TIMINGS_LOGGED_AT_INFO) McStatusClient.LOG.info(timings);
			else McStatusClient.LOG.debug(timings);

			if (image != null) finish(image, width, height);
		});
	}

	/** io pool: GPU rows come bottom-up and alpha may be anything, then encode. */
	private void finish(NativeImage image, int width, int height) {
		try (image) {
			long pixels = image.getPointer();
			long rowBytes = width * 4L;
			long swap = MemoryUtil.nmemAlloc(rowBytes);
			try {
				for (int y = 0; y < height / 2; y++) {
					long top = pixels + y * rowBytes;
					long bottom = pixels + (height - 1 - y) * rowBytes;
					MemoryUtil.memCopy(top, swap, rowBytes);
					MemoryUtil.memCopy(bottom, top, rowBytes);
					MemoryUtil.memCopy(swap, bottom, rowBytes);
				}
			} finally {
				MemoryUtil.nmemFree(swap);
			}
			for (long offset = 3; offset < (long) width * height * 4; offset += 4) {
				MemoryUtil.memPutByte(pixels + offset, (byte) 0xFF);
			}
			AtomicFiles.write(file, image::writeToFile);
		} catch (IOException err) {
			McStatusClient.LOG.warn("could not write {}: {}", file, err.getMessage());
		}
	}
}
