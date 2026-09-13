package mcstatus;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** Writes beside the target and moves into place, so readers never see half a file. */
final class AtomicFiles {
	private AtomicFiles() {}

	interface Writer {
		void write(Path temp) throws IOException;
	}

	static void write(Path target, Writer writer) throws IOException {
		Files.createDirectories(target.getParent());
		// .tmp keeps it out of the agent's *.json / *.png globs
		Path temp = target.resolveSibling(target.getFileName() + ".tmp");
		writer.write(temp);
		try {
			Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (AtomicMoveNotSupportedException err) {
			Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
		}
	}
}
