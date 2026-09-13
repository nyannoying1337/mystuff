package mcstatus.shot;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Properties;

import com.mojang.blaze3d.platform.NativeImage;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.util.Util;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Every few seconds, overwrites screenshots/latest.png with the current frame.
 * The mc-status agent publishes whichever screenshot is newest, so this turns
 * "press F2" into "always fresh" without the agent needing to know about it.
 */
public class ShotClient implements ClientModInitializer {
	private static final Logger LOG = LoggerFactory.getLogger("mc-status-shot");
	private static final int TICKS_PER_SECOND = 20;

	private int intervalTicks;
	private boolean hideHud;
	private String fileName;

	private int ticksLeft;
	private boolean waitingForHudlessFrame;
	private boolean captureInFlight;

	@Override
	public void onInitializeClient() {
		loadConfig();
		ticksLeft = intervalTicks;
		ClientTickEvents.END_CLIENT_TICK.register(this::onTick);
		LOG.info("capturing {} every {}s (hide hud: {})", fileName, intervalTicks / TICKS_PER_SECOND, hideHud);
	}

	private void onTick(Minecraft client) {
		// Only capture actual gameplay: no world, an open menu (chat included),
		// or a paused game would publish something useless or private.
		if (client.level == null || client.gui.screen() != null || client.isPaused()) {
			if (waitingForHudlessFrame) restoreHud(client);
			ticksLeft = Math.max(ticksLeft, TICKS_PER_SECOND);
			return;
		}

		if (captureInFlight) return;

		if (waitingForHudlessFrame) {
			// A tick has passed since hiding the HUD, so at least one frame
			// without it is sitting in the main render target.
			waitingForHudlessFrame = false;
			capture(client, true);
			return;
		}

		if (--ticksLeft > 0) return;
		ticksLeft = intervalTicks;

		if (hideHud && !client.gui.hud.isHidden()) {
			client.gui.hud.toggle();
			waitingForHudlessFrame = true;
			return;
		}
		capture(client, false);
	}

	private void capture(Minecraft client, boolean hudWasHidden) {
		captureInFlight = true;
		try {
			Screenshot.takeScreenshot(client.gameRenderer.mainRenderTarget(), image -> {
				// The GPU readback can finish after later frames have started, so the
				// HUD only comes back once the pixels are safely copied.
				client.execute(() -> {
					if (hudWasHidden) restoreHud(client);
					captureInFlight = false;
				});
				Util.ioPool().execute(() -> write(client, image));
			});
		} catch (RuntimeException err) {
			// Happens mid-resize when the framebuffer is incomplete; try next interval.
			LOG.debug("skipped capture: {}", err.getMessage());
			if (hudWasHidden) restoreHud(client);
			captureInFlight = false;
		}
	}

	private void restoreHud(Minecraft client) {
		waitingForHudlessFrame = false;
		if (client.gui.hud.isHidden()) client.gui.hud.toggle();
	}

	private void write(Minecraft client, NativeImage image) {
		Path dir = client.gameDirectory.toPath().resolve(Screenshot.SCREENSHOT_DIR);
		Path target = dir.resolve(fileName);
		// Written beside the target and moved into place, so the agent never
		// uploads a half-written PNG. The .tmp suffix keeps it out of the agent's glob.
		Path temp = dir.resolve(fileName + ".tmp");
		try (image) {
			Files.createDirectories(dir);
			image.writeToFile(temp);
			try {
				Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			} catch (AtomicMoveNotSupportedException err) {
				Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
			}
		} catch (IOException err) {
			LOG.warn("could not write {}: {}", target, err.getMessage());
		}
	}

	private void loadConfig() {
		Path path = FabricLoader.getInstance().getConfigDir().resolve("mc-status-shot.properties");
		Properties props = new Properties();
		props.setProperty("interval_seconds", "15");
		props.setProperty("hide_hud", "true");
		props.setProperty("file_name", "latest.png");

		if (Files.isRegularFile(path)) {
			try (InputStream in = Files.newInputStream(path)) {
				props.load(in);
			} catch (IOException err) {
				LOG.warn("could not read {}, using defaults: {}", path, err.getMessage());
			}
		} else {
			try (OutputStream out = Files.newOutputStream(path)) {
				props.store(out, "mc-status-shot: hide_hud keeps chat and coordinates out of published frames");
			} catch (IOException err) {
				LOG.warn("could not write default config {}: {}", path, err.getMessage());
			}
		}

		int seconds;
		try {
			seconds = Integer.parseInt(props.getProperty("interval_seconds").trim());
		} catch (NumberFormatException err) {
			seconds = 15;
		}
		intervalTicks = Math.max(5, seconds) * TICKS_PER_SECOND;
		hideHud = Boolean.parseBoolean(props.getProperty("hide_hud").trim());

		// A bare file name only: the config must not be able to write outside screenshots/.
		String name = props.getProperty("file_name").trim();
		fileName = name.matches("[A-Za-z0-9._-]+\\.png") ? name : "latest.png";
	}
}
