export function withoutNativePciWarning(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        !(
          line.includes(
            "[W:onnxruntime:onnxruntime-node, device_discovery.cc:",
          ) &&
          line.includes(" GetPciBusId] Skipping pci_bus_id for PCI path at ") &&
          line.includes(" did not match expected pattern of ")
        ),
    )
    .join("\n")
    .trim();
}
