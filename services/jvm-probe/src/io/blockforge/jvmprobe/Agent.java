package io.blockforge.jvmprobe;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.List;

/**
 * BlockForge JVM probe: a dependency-free -javaagent that writes heap/GC/thread statistics as JSON
 * to the file given as the agent argument every 5 seconds (temp file + atomic rename), e.g.
 * {@code -javaagent:/opt/blockforge/jvm-probe.jar=/data/.blockforge/jvm.json}.
 *
 * It runs on a single low-priority daemon thread and swallows every Throwable: it must never
 * crash, block or slow down the server it observes. Compiled with --release 8.
 */
public final class Agent {
    static final long INTERVAL_MS = 5000L;
    static final String DEFAULT_OUT = "/data/.blockforge/jvm.json";
    private static volatile boolean started;

    private Agent() {}

    public static void premain(String args) { start(args); }

    public static void premain(String args, Instrumentation inst) { start(args); }

    public static void agentmain(String args) { start(args); }

    public static void agentmain(String args, Instrumentation inst) { start(args); }

    static synchronized void start(String args) {
        if (started) {
            return;
        }
        started = true;
        try {
            final File out = new File(args == null || args.trim().isEmpty() ? DEFAULT_OUT : args.trim());
            Thread t = new Thread(new Runnable() {
                public void run() { loop(out); }
            }, "blockforge-jvm-probe");
            t.setDaemon(true);
            t.setPriority(Thread.MIN_PRIORITY);
            t.start();
        } catch (Throwable ignored) {
            // never interfere with the host application
        }
    }

    static void loop(File out) {
        while (true) {
            try {
                write(out);
            } catch (Throwable ignored) {
                // keep sampling; transient I/O errors are expected (disk full, dir removed)
            }
            try {
                Thread.sleep(INTERVAL_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    static String sample() {
        MemoryMXBean mem = ManagementFactory.getMemoryMXBean();
        MemoryUsage heap = mem.getHeapMemoryUsage();
        MemoryUsage nonHeap = mem.getNonHeapMemoryUsage();
        long gcCount = 0, gcTime = 0;
        List<GarbageCollectorMXBean> gcs = ManagementFactory.getGarbageCollectorMXBeans();
        for (GarbageCollectorMXBean gc : gcs) {
            long c = gc.getCollectionCount();
            long t = gc.getCollectionTime();
            if (c > 0) gcCount += c;
            if (t > 0) gcTime += t;
        }
        StringBuilder sb = new StringBuilder(256);
        sb.append('{');
        sb.append("\"heapUsedBytes\":").append(Math.max(0L, heap.getUsed()));
        sb.append(",\"heapCommittedBytes\":").append(Math.max(0L, heap.getCommitted()));
        if (heap.getMax() >= 0) {
            sb.append(",\"heapMaxBytes\":").append(heap.getMax());
        }
        sb.append(",\"nonHeapUsedBytes\":").append(Math.max(0L, nonHeap.getUsed()));
        sb.append(",\"gcCountTotal\":").append(gcCount);
        sb.append(",\"gcTimeMsTotal\":").append(gcTime);
        sb.append(",\"threads\":").append(ManagementFactory.getThreadMXBean().getThreadCount());
        sb.append(",\"uptimeMs\":").append(ManagementFactory.getRuntimeMXBean().getUptime());
        sb.append(",\"sampledAt\":").append(System.currentTimeMillis());
        sb.append('}');
        return sb.toString();
    }

    static void write(File out) throws Exception {
        File dir = out.getAbsoluteFile().getParentFile();
        if (dir != null && !dir.isDirectory()) {
            dir.mkdirs();
        }
        File tmp = new File(dir, "." + out.getName() + ".tmp");
        byte[] data = sample().getBytes(Charset.forName("UTF-8"));
        OutputStream os = new FileOutputStream(tmp);
        try {
            os.write(data);
        } finally {
            os.close();
        }
        try {
            Files.move(tmp.toPath(), out.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception atomicUnsupported) {
            Files.move(tmp.toPath(), out.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
