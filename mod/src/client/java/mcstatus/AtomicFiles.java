package mcstatus;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** Writes beside the target and moves into place, so readers never see half a file. */
final class AtomicFiles {
	private static final int MOVE_ATTEMPTS = 4;

	private AtomicFiles() {}

	interface Writer {
		void write(Path temp) throws IOException;
	}

	static void write(Path target, Writer writer) throws IOException {
		Files.createDirectories(target.getParent());
		// .tmp keeps it out of the agent's *.json / *.png globs
		Path temp = target.resolveSibling(target.getFileName() + ".tmp");
		writer.write(temp);
		for (int attempt = 1; ; attempt++) {
			try {
				move(temp, target);
				return;
			} catch (FileSystemException err) {
				// Windows refuses to replace a file another process has open, and the
				// agent reads these every few seconds; it lets go within milliseconds.
				if (attempt == MOVE_ATTEMPTS) {
					Files.deleteIfExists(temp);
					throw err;
				}
				try {
					Thread.sleep(15L * attempt);
				} catch (InterruptedException interrupted) {
					Thread.currentThread().interrupt();
					throw err;
				}
			}
		}
	}

	private static void move(Path temp, Path target) throws IOException {
		try {
			Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (AtomicMoveNotSupportedException err) {
			Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
		}
	}
}
