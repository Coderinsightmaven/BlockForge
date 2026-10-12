import { z } from "zod";
import { Bytes, EpochMs } from "../common.js";

export const NetworkInterfaceFact = z.object({
  name: z.string(),
  mac: z.string().optional(),
  mtu: z.number().int().optional(),
  addresses: z.array(z.string()),
  up: z.boolean().optional(),
});

export const FilesystemFact = z.object({
  mount: z.string(),
  device: z.string().optional(),
  fsType: z.string().optional(),
  totalBytes: Bytes,
});

export const ContainerRuntimeFact = z.object({
  name: z.enum(["docker", "podman"]),
  version: z.string(),
  apiVersion: z.string().optional(),
  rootless: z.boolean(),
  cgroupVersion: z.string().optional(),
  storageDriver: z.string().optional(),
  healthy: z.boolean(),
  error: z.string().optional(),
});

export const JavaRuntimeFact = z.object({
  major: z.number().int(),
  version: z.string(),
  vendor: z.string().optional(),
  /** "image" = container image tag available locally; "host" = host-installed JRE. */
  source: z.enum(["image", "host"]),
  ref: z.string(),
});

export const NodeFacts = z.object({
  hostname: z.string(),
  os: z.string(),
  platform: z.string().optional(),
  platformVersion: z.string().optional(),
  kernelVersion: z.string().optional(),
  arch: z.string(),
  cpuModel: z.string().optional(),
  cpuPhysicalCores: z.number().int().nonnegative().optional(),
  cpuLogicalCores: z.number().int().positive(),
  memoryTotalBytes: Bytes,
  swapTotalBytes: Bytes.optional(),
  bootTime: EpochMs.optional(),
  timezone: z.string().optional(),
  dataRoot: z.string(),
  interfaces: z.array(NetworkInterfaceFact),
  filesystems: z.array(FilesystemFact),
  containerRuntime: ContainerRuntimeFact.nullable(),
  javaRuntimes: z.array(JavaRuntimeFact).default([]),
});
export type NodeFacts = z.infer<typeof NodeFacts>;
