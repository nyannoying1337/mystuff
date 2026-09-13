package mcstatus;

import com.mojang.blaze3d.buffers.GpuBuffer;
import com.mojang.blaze3d.buffers.GpuBufferSlice;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.GpuDevice;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.GpuTexture;
import net.minecraft.client.Minecraft;
import net.minecraft.util.Util;
import org.lwjgl.system.MemoryUtil;

/**
 * Copies a GPU texture into a {@link NativeImage} without stalling the game.
 *
 * <p>The copy is queued on the GPU, the buffer is mapped on the render thread
 * once it's ready, and the actual memory copy happens on the io pool: on some
 * drivers (Intel OpenGL for one) reading mapped memory is slow, about 40 ms for
 * a small frame. The buffer is unmapped back on the render thread. The result
 * is flipped upright and opaque, and handed over on the io pool.
 */
final class GpuReadback {
	/** Milliseconds spent on the render thread and off it, for the log. */
	record Timings(double renderThreadMs, double copyMs) {}

	private GpuReadback() {}

	/**
	 * Render thread. Returns false if the texture can't be read (the callback is
	 * then never called). Otherwise {@code done} runs on the io pool with an image
	 * the callee must close, or with null if the copy failed.
	 */
	static boolean read(GpuTexture texture, int width, int height, ReadbackCallback done) {
		int bytesPerPixel = texture.getFormat().blockSize();
		if (bytesPerPixel != 4) {
			// the bulk copy assumes 8-bit RGBA, which is what the game uses
			McStatusClient.LOG.debug("skipped readback: unexpected format {}", texture.getFormat());
			return false;
		}
		long started = System.nanoTime();
		GpuDevice device = RenderSystem.getDevice();
		GpuBuffer buffer = device.createBuffer(() -> "mc-status readback",
			GpuBuffer.USAGE_MAP_READ | GpuBuffer.USAGE_COPY_DST, (long) width * height * bytesPerPixel);
		long[] issuedNs = new long[1];
		// Only the time spent here and in onReady blocks the render thread; the
		// frames the GPU takes to finish the copy in between don't.
		device.createCommandEncoder().copyTextureToBuffer(texture, buffer, 0L,
			() -> onReady(buffer, width, height, issuedNs[0], done), 0);
		issuedNs[0] = System.nanoTime() - started;
		return true;
	}

	@FunctionalInterface
	interface ReadbackCallback {
		void accept(NativeImage image, Timings timings);
	}

	private static void onReady(GpuBuffer buffer, int width, int height, long issuedNs, ReadbackCallback done) {
		long started = System.nanoTime();
		GpuBufferSlice.MappedView view;
		try {
			view = buffer.map(true, false);
		} catch (RuntimeException err) {
			buffer.close();
			McStatusClient.LOG.debug("readback map failed: {}", err.toString());
			Util.ioPool().execute(() -> done.accept(null, new Timings(0, 0)));
			return;
		}
		double renderThreadMs = (issuedNs + System.nanoTime() - started) / 1e6;
		long address = MemoryUtil.memAddress(view.data());
		Minecraft client = Minecraft.getInstance();

		Util.ioPool().execute(() -> {
			long copyStarted = System.nanoTime();
			NativeImage image = null;
			try {
				image = new NativeImage(width, height, false);
				// RGBA8 texture bytes are already in NativeImage's RGBA layout.
				MemoryUtil.memCopy(address, image.getPointer(), (long) width * height * 4);
			} catch (RuntimeException err) {
				if (image != null) image.close();
				image = null;
				McStatusClient.LOG.debug("readback copy failed: {}", err.toString());
			}
			double copyMs = (System.nanoTime() - copyStarted) / 1e6;
			client.execute(() -> {
				view.close();
				buffer.close();
			});
			if (image != null) makeUpright(image, width, height);
			done.accept(image, new Timings(renderThreadMs, copyMs));
		});
	}

	/** GPU rows come bottom-up and alpha may be anything. */
	private static void makeUpright(NativeImage image, int width, int height) {
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
	}
}
