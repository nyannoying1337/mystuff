package mcstatus;

import java.util.UUID;

import com.google.gson.JsonObject;
import mcstatus.common.Snapshots;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * Statistics and advancements, read from the integrated server — so singleplayer
 * only. The client never has these for servers without asking, and servers
 * aren't ours to report on anyway.
 *
 * <p>Collected on the server thread every few seconds and handed to
 * {@link StateWriter} as a finished object, so nothing here races the game.
 */
final class Progress {
	private static final long INTERVAL_MS = 10_000;

	private volatile JsonObject stats;
	private volatile JsonObject advancements;
	private long nextAt;
	private volatile boolean pending;

	JsonObject stats() {
		return stats;
	}

	JsonObject advancements() {
		return advancements;
	}

	/** Client thread. */
	void tick(Minecraft client) {
		IntegratedServer server = client.getSingleplayerServer();
		if (server == null || client.player == null) {
			stats = null;
			advancements = null;
			nextAt = 0;
			return;
		}
		long now = System.currentTimeMillis();
		if (pending || now < nextAt) return;
		nextAt = now + INTERVAL_MS;
		pending = true;
		UUID id = client.player.getUUID();
		server.execute(() -> {
			try {
				ServerPlayer player = server.getPlayerList().getPlayer(id);
				if (player != null) {
					stats = Snapshots.stats(player.getStats());
					advancements = Snapshots.advancements(server,
						holder -> Snapshots.live(player.getAdvancements().getOrStartProgress(holder)));
				}
			} catch (RuntimeException err) {
				McStatusClient.LOG.debug("skipped progress: {}", err.toString());
			} finally {
				pending = false;
			}
		});
	}
}
