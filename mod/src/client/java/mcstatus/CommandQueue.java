package mcstatus;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.util.Util;

/**
 * Runs commands the agent drops into commands/ — how curses reach a
 * singleplayer world, which has no RCON. Only the integrated server is ever
 * touched; on multiplayer the folder is left alone.
 */
final class CommandQueue {
	private static final int CHECK_EVERY_TICKS = 20;
	private static final long MAX_FILE_BYTES = 64 * 1024;
	private static final int MAX_COMMANDS_PER_FILE = 20;
	// A curse is a reaction to "right now"; one that's a minute old is dropped.
	private static final long MAX_AGE_MS = 60_000;

	private final Path dir;
	private final AtomicBoolean scanning = new AtomicBoolean();
	private int ticks;

	CommandQueue(Path dir) {
		this.dir = dir;
	}

	void tick(Minecraft client) {
		if (++ticks < CHECK_EVERY_TICKS) return;
		ticks = 0;
		if (client.player == null) return;
		IntegratedServer server = client.getSingleplayerServer();
		if (!scanning.compareAndSet(false, true)) return;
		Util.ioPool().execute(() -> {
			try {
				// On a server nothing runs; stale files are still cleared so they
				// can't all fire the next time a singleplayer world opens.
				List<String> commands = drain(server != null);
				if (server != null && !commands.isEmpty()) server.execute(() -> run(server, commands));
			} finally {
				scanning.set(false);
			}
		});
	}

	private List<String> drain(boolean runnable) {
		List<String> commands = new ArrayList<>();
		if (!Files.isDirectory(dir)) return commands;
		List<Path> files = new ArrayList<>();
		try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "*.json")) {
			stream.forEach(files::add);
		} catch (IOException err) {
			McStatusClient.LOG.warn("could not list {}: {}", dir, err.getMessage());
			return commands;
		}
		files.sort(null); // agent names files by timestamp
		long now = System.currentTimeMillis();
		for (Path file : files) {
			boolean stale;
			try {
				stale = now - Files.getLastModifiedTime(file).toMillis() > MAX_AGE_MS;
			} catch (IOException err) {
				continue; // vanished meanwhile
			}
			if (!runnable && !stale) continue; // might still be meant for a world that's opening
			if (stale) {
				McStatusClient.LOG.info("dropping stale command file {}", file.getFileName());
			}
			try {
				if (!stale && Files.size(file) <= MAX_FILE_BYTES) {
					JsonObject body = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
					JsonArray list = body.getAsJsonArray("commands");
					if (list != null) {
						if (list.size() > MAX_COMMANDS_PER_FILE) {
							McStatusClient.LOG.warn("{} has {} commands; running the first {}",
								file.getFileName(), list.size(), MAX_COMMANDS_PER_FILE);
						}
						int taken = 0;
						for (JsonElement command : list) {
							if (taken++ >= MAX_COMMANDS_PER_FILE) break;
							commands.add(command.getAsString());
						}
					}
				}
			} catch (RuntimeException | IOException err) {
				McStatusClient.LOG.warn("skipping unreadable command file {}: {}", file.getFileName(), err.getMessage());
			}
			try {
				Files.deleteIfExists(file);
			} catch (IOException err) {
				McStatusClient.LOG.warn("could not delete {}: {}", file.getFileName(), err.getMessage());
			}
		}
		return commands;
	}

	private static void run(IntegratedServer server, List<String> commands) {
		for (String command : commands) {
			String line = command.startsWith("/") ? command.substring(1) : command;
			McStatusClient.LOG.info("curse: /{}", line);
			// Suppressed output: no "[Server: Filled 25 blocks]" spam in chat.
			server.getCommands().performPrefixedCommand(server.createCommandSourceStack().withSuppressedOutput(), line);
		}
	}
}
