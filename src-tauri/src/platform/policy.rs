//! Device policy (D2, D7–D9): pure mapping from probed hardware to device, precision
//! and torch wheel variant, plus the parsers it needs. Compiled and unit-tested on
//! every platform, while each build only calls its own OS's half — hence the
//! module-wide `dead_code` allowance.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Oldest CUDA compute capability the cu128 torch wheels ship kernels for: torch
/// 2.10.0+cu128 reports sm_70 … sm_120 (Volta and newer), measured in S1 with
/// `torch.cuda.get_arch_list()` (docs/decisions.md, D2).
pub const MIN_CUDA_CAPABILITY: (u32, u32) = (7, 0);
/// "8 GB class" cards report a little under 8 GiB; at or above this, fp32 (D9).
pub const FP32_MIN_VRAM_MIB: u64 = 7_680;
/// "6 GB class" cards; below this the GPU is not used (D9).
pub const GPU_MIN_VRAM_MIB: u64 = 5_632;
/// bf16 needs Ampere (compute capability 8.0) or newer.
pub const BF16_MIN_CAPABILITY: (u32, u32) = (8, 0);
/// CUDA 12.8 wants an R570+ driver for full support (older drivers may still work).
pub const MIN_DRIVER_MAJOR: u32 = 570;
/// Apple Silicon: 16 GB recommended (D9); Macs report exactly 16 GiB.
pub const RECOMMENDED_MEMORY_BYTES: u64 = 15 * 1024 * 1024 * 1024;
/// requirements.md §4 (provisional): macOS 14 or later.
pub const MIN_MACOS_MAJOR: u32 = 14;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Device {
    Cuda,
    Mps,
    Cpu,
}

impl Device {
    pub fn as_str(self) -> &'static str {
        match self {
            Device::Cuda => "cuda",
            Device::Mps => "mps",
            Device::Cpu => "cpu",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Precision {
    Fp32,
    Bf16,
}

impl Precision {
    pub fn as_str(self) -> &'static str {
        match self {
            Precision::Fp32 => "fp32",
            Precision::Bf16 => "bf16",
        }
    }
}

/// Which torch wheels first-run setup installs (D2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TorchVariant {
    /// Windows + NVIDIA: download.pytorch.org cu128 index.
    Cu128,
    /// Windows CPU mode: download.pytorch.org cpu index.
    Cpu,
    /// macOS: default PyPI wheels (include MPS).
    Pypi,
}

/// Informational findings the setup wizard explains (codes, translated by the UI).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Notice {
    CpuModeSlow,
    NoNvidiaGpu,
    GpuTooOld,
    VramTooLow,
    LowVramBf16,
    LowVramFp32,
    DriverUpdateRecommended,
    M1Unsupported,
    LowMemory,
    MacosOld,
}

/// Hard stops: the app cannot run on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    IntelMac,
    UnsupportedOs,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DevicePlan {
    pub device: Device,
    pub precision: Precision,
    pub torch_variant: TorchVariant,
    /// Set only when several NVIDIA GPUs exist: the one to use (nvidia-smi index).
    pub gpu_index: Option<u32>,
    pub notices: Vec<Notice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OsKind {
    Windows,
    Macos,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NvidiaGpu {
    pub index: u32,
    pub name: String,
    pub compute_capability: String,
    pub vram_mib: u64,
    pub driver_version: String,
}

impl NvidiaGpu {
    fn capability(&self) -> (u32, u32) {
        parse_major_minor(&self.compute_capability).unwrap_or((0, 0))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppleSilicon {
    pub chip: String,
    pub arm64: bool,
    pub memory_bytes: u64,
    pub macos_version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeReport {
    pub os: OsKind,
    pub nvidia: Vec<NvidiaGpu>,
    pub apple: Option<AppleSilicon>,
    pub blocker: Option<Blocker>,
    pub recommended: DevicePlan,
    /// What the explicit "use CPU mode" choice gives on this machine.
    pub cpu: DevicePlan,
}

/// CPU mode. Never chosen silently: it always carries `CpuModeSlow` (D7).
pub fn cpu_plan(os: OsKind, reason: Option<Notice>) -> DevicePlan {
    let mut notices = vec![Notice::CpuModeSlow];
    notices.extend(reason);
    DevicePlan {
        device: Device::Cpu,
        precision: Precision::Fp32,
        torch_variant: if os == OsKind::Macos {
            TorchVariant::Pypi
        } else {
            TorchVariant::Cpu
        },
        gpu_index: None,
        notices,
    }
}

/// Windows policy (D7, D9): usable NVIDIA GPU → CUDA, otherwise explicit CPU mode.
pub fn windows_plan(gpus: &[NvidiaGpu]) -> DevicePlan {
    if gpus.is_empty() {
        return cpu_plan(OsKind::Windows, Some(Notice::NoNvidiaGpu));
    }
    let Some(best) = gpus
        .iter()
        .filter(|g| g.capability() >= MIN_CUDA_CAPABILITY)
        .max_by_key(|g| g.vram_mib)
    else {
        return cpu_plan(OsKind::Windows, Some(Notice::GpuTooOld));
    };
    if best.vram_mib < GPU_MIN_VRAM_MIB {
        return cpu_plan(OsKind::Windows, Some(Notice::VramTooLow));
    }

    let mut notices = Vec::new();
    let precision = if best.vram_mib >= FP32_MIN_VRAM_MIB {
        Precision::Fp32
    } else if best.capability() >= BF16_MIN_CAPABILITY {
        notices.push(Notice::LowVramBf16);
        Precision::Bf16
    } else {
        notices.push(Notice::LowVramFp32);
        Precision::Fp32
    };
    let driver_major = best
        .driver_version
        .split('.')
        .next()
        .and_then(|m| m.trim().parse::<u32>().ok());
    if driver_major.is_some_and(|m| m < MIN_DRIVER_MAJOR) {
        notices.push(Notice::DriverUpdateRecommended);
    }

    DevicePlan {
        device: Device::Cuda,
        precision,
        torch_variant: TorchVariant::Cu128,
        gpu_index: (gpus.len() > 1).then_some(best.index),
        notices,
    }
}

/// macOS policy (D8, D9): Apple Silicon → MPS fp32; M1 warns; Intel is blocked.
pub fn mac_plan(apple: &AppleSilicon) -> (DevicePlan, Option<Blocker>) {
    if !apple.arm64 {
        return (cpu_plan(OsKind::Macos, None), Some(Blocker::IntelMac));
    }
    let mut notices = Vec::new();
    if apple_generation(&apple.chip) == Some(1) {
        notices.push(Notice::M1Unsupported);
    }
    if apple.memory_bytes < RECOMMENDED_MEMORY_BYTES {
        notices.push(Notice::LowMemory);
    }
    if parse_major_minor(&apple.macos_version).is_some_and(|(major, _)| major < MIN_MACOS_MAJOR) {
        notices.push(Notice::MacosOld);
    }
    let plan = DevicePlan {
        device: Device::Mps,
        precision: Precision::Fp32,
        torch_variant: TorchVariant::Pypi,
        gpu_index: None,
        notices,
    };
    (plan, None)
}

/// "Apple M2 Pro" → Some(2). None for chips without an "M<n>" name.
pub fn apple_generation(chip: &str) -> Option<u32> {
    let rest = chip.trim().strip_prefix("Apple M")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Parse `nvidia-smi --query-gpu=index,name,compute_cap,memory.total,driver_version
/// --format=csv,noheader,nounits` output.
pub fn parse_nvidia_smi(output: &str) -> Vec<NvidiaGpu> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            let [index, name, cap, vram, driver] = fields.as_slice() else {
                return None;
            };
            Some(NvidiaGpu {
                index: index.parse().ok()?,
                name: (*name).to_string(),
                compute_capability: (*cap).to_string(),
                vram_mib: vram.parse().ok()?,
                driver_version: (*driver).to_string(),
            })
        })
        .collect()
}

fn parse_major_minor(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |m| m.parse().ok())?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(index: u32, cap: &str, vram_mib: u64, driver: &str) -> NvidiaGpu {
        NvidiaGpu {
            index,
            name: format!("GPU {index}"),
            compute_capability: cap.to_string(),
            vram_mib,
            driver_version: driver.to_string(),
        }
    }

    #[test]
    fn parses_nvidia_smi_csv() {
        let out =
            "0, NVIDIA GeForce RTX 5090, 12.0, 32607, 610.88\n\n1, Tesla T4, 7.5, 15360, 560.94\n";
        let gpus = parse_nvidia_smi(out);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 5090");
        assert_eq!(gpus[0].compute_capability, "12.0");
        assert_eq!(gpus[0].vram_mib, 32_607);
        assert_eq!(gpus[1].driver_version, "560.94");
        assert!(parse_nvidia_smi("garbage\nNo devices were found").is_empty());
    }

    #[test]
    fn rtx50_gets_cuda_fp32() {
        let plan = windows_plan(&[gpu(0, "12.0", 32_607, "610.88")]);
        assert_eq!(plan.device, Device::Cuda);
        assert_eq!(plan.precision, Precision::Fp32);
        assert_eq!(plan.torch_variant, TorchVariant::Cu128);
        assert_eq!(plan.gpu_index, None);
        assert!(plan.notices.is_empty());
    }

    #[test]
    fn no_or_unusable_gpu_means_explicit_cpu_mode() {
        let none = windows_plan(&[]);
        assert_eq!(none.device, Device::Cpu);
        assert_eq!(none.torch_variant, TorchVariant::Cpu);
        assert_eq!(none.notices, vec![Notice::CpuModeSlow, Notice::NoNvidiaGpu]);

        let pascal = windows_plan(&[gpu(0, "6.1", 11_264, "580.00")]);
        assert_eq!(pascal.notices, vec![Notice::CpuModeSlow, Notice::GpuTooOld]);

        let tiny = windows_plan(&[gpu(0, "8.6", 4_096, "580.00")]);
        assert_eq!(tiny.notices, vec![Notice::CpuModeSlow, Notice::VramTooLow]);
    }

    #[test]
    fn low_vram_uses_bf16_on_ampere_and_fp32_on_turing() {
        let ampere = windows_plan(&[gpu(0, "8.6", 6_144, "580.00")]);
        assert_eq!(ampere.precision, Precision::Bf16);
        assert_eq!(ampere.notices, vec![Notice::LowVramBf16]);

        let turing = windows_plan(&[gpu(0, "7.5", 6_144, "580.00")]);
        assert_eq!(turing.device, Device::Cuda);
        assert_eq!(turing.precision, Precision::Fp32);
        assert_eq!(turing.notices, vec![Notice::LowVramFp32]);

        let eight_gb = windows_plan(&[gpu(0, "8.9", 8_188, "580.00")]);
        assert_eq!(eight_gb.precision, Precision::Fp32);
    }

    #[test]
    fn old_driver_is_flagged_and_best_gpu_is_selected() {
        let plan = windows_plan(&[
            gpu(0, "7.5", 6_144, "552.22"),
            gpu(1, "8.9", 24_564, "552.22"),
        ]);
        assert_eq!(plan.gpu_index, Some(1));
        assert_eq!(plan.precision, Precision::Fp32);
        assert_eq!(plan.notices, vec![Notice::DriverUpdateRecommended]);
    }

    fn mac(chip: &str, arm64: bool, gib: u64, version: &str) -> AppleSilicon {
        AppleSilicon {
            chip: chip.to_string(),
            arm64,
            memory_bytes: gib * 1024 * 1024 * 1024,
            macos_version: version.to_string(),
        }
    }

    #[test]
    fn mac_policy() {
        let (m2, blocker) = mac_plan(&mac("Apple M2 Pro", true, 16, "14.5"));
        assert_eq!(blocker, None);
        assert_eq!(m2.device, Device::Mps);
        assert_eq!(m2.precision, Precision::Fp32);
        assert_eq!(m2.torch_variant, TorchVariant::Pypi);
        assert!(m2.notices.is_empty());

        let (m1, _) = mac_plan(&mac("Apple M1", true, 8, "13.6"));
        assert_eq!(
            m1.notices,
            vec![Notice::M1Unsupported, Notice::LowMemory, Notice::MacosOld]
        );

        let (_, intel) = mac_plan(&mac("Intel(R) Core(TM) i7", false, 16, "14.0"));
        assert_eq!(intel, Some(Blocker::IntelMac));
    }

    #[test]
    fn apple_generation_parsing() {
        assert_eq!(apple_generation("Apple M1"), Some(1));
        assert_eq!(apple_generation("Apple M4 Max"), Some(4));
        assert_eq!(apple_generation("Apple M10"), Some(10));
        assert_eq!(apple_generation("Intel(R) Core(TM)"), None);
    }
}
