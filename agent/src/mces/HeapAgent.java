package mces;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.nio.charset.StandardCharsets;

/**
 * MCES 힙 측정 에이전트 (-javaagent:mces-agent.jar=logs/mces-heap.txt)
 * 2초마다 "사용 커밋 최대 시각(ms)" 한 줄을 파일에 덮어쓴다. 서버 동작에는 관여하지 않는다.
 * Java 8 이상에서 동작하도록 --release 8 로 빌드한다.
 */
public final class HeapAgent {
    private HeapAgent() {}

    public static void premain(String args) {
        start(args);
    }

    public static void agentmain(String args) {
        start(args);
    }

    private static void start(String args) {
        final File out = new File(args == null || args.isEmpty() ? "logs/mces-heap.txt" : args);
        Thread t = new Thread(new Runnable() {
            public void run() {
                MemoryMXBean bean = ManagementFactory.getMemoryMXBean();
                while (true) {
                    try {
                        MemoryUsage u = bean.getHeapMemoryUsage();
                        String line = u.getUsed() + " " + u.getCommitted() + " " + u.getMax() + " " + System.currentTimeMillis() + "\n";
                        File dir = out.getAbsoluteFile().getParentFile();
                        if (dir != null) dir.mkdirs();
                        FileOutputStream fos = new FileOutputStream(out, false);
                        try {
                            fos.write(line.getBytes(StandardCharsets.US_ASCII));
                        } finally {
                            fos.close();
                        }
                        Thread.sleep(2000);
                    } catch (InterruptedException e) {
                        return;
                    } catch (Throwable e) {
                        try {
                            Thread.sleep(5000);
                        } catch (InterruptedException ie) {
                            return;
                        }
                    }
                }
            }
        }, "MCES-heap");
        t.setDaemon(true);
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
    }
}
