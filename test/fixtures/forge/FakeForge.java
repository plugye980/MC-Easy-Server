import java.io.*;
import java.nio.file.*;

/** 테스트용 가짜 Forge: 설치 프로그램(--installServer)이면서 서버 본체 */
public class FakeForge {
    public static void main(String[] a) throws Exception {
        if (a.length > 0 && a[0].equals("--installServer")) {
            System.out.println("Extracting libraries...");
            Path self = Paths.get(FakeForge.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            Files.copy(self, Paths.get("forge-server.jar"), StandardCopyOption.REPLACE_EXISTING);
            Path dir = Paths.get("libraries/net/minecraftforge/forge/1.20.1-47.3.0");
            Files.createDirectories(dir);
            for (String f : new String[] { "unix_args.txt", "win_args.txt" }) Files.write(dir.resolve(f), "-cp forge-server.jar FakeForge\n".getBytes());
            Files.write(Paths.get("run.sh"), "java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt \"$@\"\n".getBytes());
            System.out.println("The server installed successfully");
            return;
        }
        System.out.println("[12:00:00] [main/INFO]: ModLauncher running");
        new File("world").mkdirs();
        new FileOutputStream("world/level.dat").close();
        System.out.println("[12:00:01] [Server thread/INFO] [minecraft/DedicatedServer]: Done (1.0s)! For help, type \"help\"");
        BufferedReader r = new BufferedReader(new InputStreamReader(System.in));
        String l;
        while ((l = r.readLine()) != null) {
            if (l.equals("stop")) {
                System.out.println("[12:00:02] [Server thread/INFO]: Stopping server");
                System.exit(0);
            }
        }
    }
}
