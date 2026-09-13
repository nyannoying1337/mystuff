package mcstatus;

import java.nio.file.Path;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.PauseScreen;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The game side of mc-status. Everything it shares goes through files in
 * {@code <gameDir>/mc-status/}, which the agent reads and uploads:
 *
 * <ul>
 *   <li>{@code state.json} — health, hunger, XP, full inventory, position</li>
 *   <li>{@code latest.png} — a small frame of the world, without the HUD</li>
 *   <li>{@code commands/*.json} — written by the agent (curses), run here in singleplayer</li>
 * </ul>
 */
public class McStatusClient implements ClientModInitializer {
	public static final Logger LOG = LoggerFactory.getLogger("mc-status");

	@Override
	public void onInitializeClient() {
		ModConfig config = ModConfig.load(FabricLoader.getInstance().getConfigDir().resolve("mc-status.properties"));
		Path dir = Minecraft.getInstance().gameDirectory.toPath().resolve("mc-status");

		StateWriter state = new StateWriter(dir.resolve("state.json"), config);
		CommandQueue commands = new CommandQueue(dir.resolve("commands"));
		FrameCapture capture = new FrameCapture(dir.resolve("latest.png"), config);

		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			state.tick(client);
			commands.tick(client);
		});
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> state.markOffline());
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> state.markOffline());

		LevelRenderEvents.END_MAIN.register(context -> capture.onLevelRendered(Minecraft.getInstance()));
		// Pausing (and Save & Quit, which always goes through the pause menu)
		// grabs the last thing you were looking at.
		ScreenEvents.AFTER_INIT.register((client, screen, width, height) -> {
			if (screen instanceof PauseScreen) capture.requestSoon();
		});

		LOG.info("writing to {} (capture every {}s at {}px)", dir, config.captureIntervalSeconds, config.captureWidth);
	}
}
