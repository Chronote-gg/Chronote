import { withoutNativePciWarning } from "./nativeRuntimeDiagnostics";

const warning =
  '2026-01-01 00:00:00.000000 [W:onnxruntime:onnxruntime-node, device_discovery.cc:146 GetPciBusId] Skipping pci_bus_id for PCI path at "/sys/devices/synthetic" because filename "synthetic-guid" did not match expected pattern of a PCI bus identifier';

test("accepts an empty diagnostic stream and the known CPU discovery warning", () => {
  expect(withoutNativePciWarning("")).toBe("");
  expect(withoutNativePciWarning(`\u001b[0;93m${warning}\u001b[m\n`)).toBe("");
});

test("retains an error alongside the known warning", () => {
  expect(withoutNativePciWarning(`${warning}\nError: inference failed\n`)).toBe(
    "Error: inference failed",
  );
});

test("retains other native discovery diagnostics", () => {
  const unknown = warning.replace(
    "Skipping pci_bus_id",
    "Unexpected PCI failure",
  );
  expect(withoutNativePciWarning(unknown)).toBe(unknown);
});
