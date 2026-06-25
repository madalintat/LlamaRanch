// Machine probing for fit decisions: how much memory the box has, and what kind
// of accelerator it can put a model on. RAM detection is the single source of
// truth (config.rs delegates here). The budgets and parsers are pure so the fit
// math can be unit-tested without a real GPU.
use std::process::Command;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * 1024 * 1024;

/// What the model can be offloaded onto. `Nvidia` carries its total VRAM in
/// bytes; `AppleSilicon` shares one unified memory pool with the system; `Cpu`
/// means no usable accelerator (model runs on the CPU, which works but is slow).
#[derive(Debug, Clone, PartialEq)]
pub enum GpuKind {
    AppleSilicon,
    Nvidia { vram: u64 },
    Cpu,
}

/// A snapshot of the machine's memory situation for fitting a model.
#[derive(Debug, Clone, PartialEq)]
pub struct Hardware {
    pub total_ram: u64,
    pub gpu: GpuKind,
}

impl Hardware {
    /// Bytes a model can occupy and still run comfortably on the accelerator
    /// (the "fast" path). Apple Silicon shares RAM, so reserve ~30% for the OS
    /// and app. A discrete NVIDIA card reserves a 512 MiB working margin. A
    /// CPU-only box has no fast path.
    pub fn fast_budget(&self) -> u64 {
        match self.gpu {
            GpuKind::AppleSilicon => self.total_ram / 100 * 70,
            GpuKind::Nvidia { vram } => vram.saturating_sub(512 * MIB),
            GpuKind::Cpu => 0,
        }
    }

    /// Bytes a model can occupy and still run at all (possibly slowly). On Apple
    /// Silicon, past ~90% of RAM the machine starts swapping to disk (the real
    /// cliff). A discrete card can offload overflow layers into system RAM, so
    /// its ceiling is total RAM. A CPU-only box is bounded by RAM with headroom.
    pub fn usable_ceiling(&self) -> u64 {
        match self.gpu {
            GpuKind::AppleSilicon => self.total_ram / 100 * 90,
            GpuKind::Nvidia { .. } => self.total_ram,
            GpuKind::Cpu => self.total_ram / 100 * 90,
        }
    }

    /// Short human label for the accelerator, e.g. "Apple Silicon", "NVIDIA
    /// (12 GB)", "CPU". NVIDIA VRAM is shown in GiB (how cards are sized).
    pub fn gpu_label(&self) -> String {
        match self.gpu {
            GpuKind::AppleSilicon => "Apple Silicon".to_string(),
            GpuKind::Nvidia { vram } => {
                let gb = (vram as f64 / GIB as f64).round() as u64;
                format!("NVIDIA ({gb} GB)")
            }
            GpuKind::Cpu => "CPU".to_string(),
        }
    }
}

/// Total physical RAM in bytes, per-OS, std only. None if detection fails. This
/// is the single source of truth; `config.rs` calls through here.
pub fn total_ram_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
    #[cfg(target_os = "linux")]
    {
        let txt = std::fs::read_to_string("/proc/meminfo").ok()?;
        for line in txt.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
                return Some(kb * 1024);
            }
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

/// Parse `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`,
/// whose first line is the first GPU's total memory in MiB. Returns bytes.
fn parse_nvidia_smi(out: &str) -> Option<u64> {
    let first = out.lines().next()?.trim();
    let mib: u64 = first.parse().ok()?;
    Some(mib * MIB)
}

/// True for an Apple Silicon Mac, from the CPU brand string and machine arch.
/// Only consulted on macOS; kept compiled (and tested) everywhere.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn apple_silicon_present(brand: &str, arch: &str) -> bool {
    brand.contains("Apple") && (arch.contains("arm64") || arch.contains("aarch64"))
}

/// Query NVIDIA total VRAM via `nvidia-smi`, if the tool and a card are present.
fn nvidia_vram() -> Option<u64> {
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout))
}

/// macOS CPU brand string (e.g. "Apple M3 Pro"), via sysctl.
#[cfg(target_os = "macos")]
fn macos_cpu_brand() -> String {
    Command::new("sysctl")
        .args(["-n", "machdep.cpu.brand_string"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Probe the machine. RAM from `total_ram_bytes`; accelerator: Apple Silicon on
/// an Apple arm64 Mac, else an NVIDIA card if `nvidia-smi` reports one, else CPU.
pub fn detect() -> Hardware {
    let total_ram = total_ram_bytes().unwrap_or(0);
    let gpu = detect_gpu();
    Hardware { total_ram, gpu }
}

#[cfg(target_os = "macos")]
fn detect_gpu() -> GpuKind {
    if apple_silicon_present(&macos_cpu_brand(), std::env::consts::ARCH) {
        return GpuKind::AppleSilicon;
    }
    // Intel Macs almost never carry a supported discrete card these days; still,
    // honor one if nvidia-smi finds it, otherwise fall back to CPU.
    match nvidia_vram() {
        Some(vram) => GpuKind::Nvidia { vram },
        None => GpuKind::Cpu,
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_gpu() -> GpuKind {
    match nvidia_vram() {
        Some(vram) => GpuKind::Nvidia { vram },
        None => GpuKind::Cpu,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ram() -> u64 {
        64 * GIB
    }

    #[test]
    fn apple_silicon_fast_budget_is_70_percent() {
        let hw = Hardware { total_ram: ram(), gpu: GpuKind::AppleSilicon };
        assert_eq!(hw.fast_budget(), ram() / 100 * 70);
    }

    #[test]
    fn apple_silicon_usable_ceiling_is_90_percent() {
        let hw = Hardware { total_ram: ram(), gpu: GpuKind::AppleSilicon };
        assert_eq!(hw.usable_ceiling(), ram() / 100 * 90);
    }

    #[test]
    fn nvidia_fast_budget_reserves_512_mib() {
        let hw = Hardware { total_ram: ram(), gpu: GpuKind::Nvidia { vram: 12 * GIB } };
        assert_eq!(hw.fast_budget(), 12 * GIB - 512 * MIB);
    }

    #[test]
    fn nvidia_usable_ceiling_is_total_ram() {
        let hw = Hardware { total_ram: ram(), gpu: GpuKind::Nvidia { vram: 12 * GIB } };
        assert_eq!(hw.usable_ceiling(), ram());
    }

    #[test]
    fn nvidia_fast_budget_saturates_on_tiny_card() {
        let hw = Hardware { total_ram: ram(), gpu: GpuKind::Nvidia { vram: 256 * MIB } };
        assert_eq!(hw.fast_budget(), 0);
    }

    #[test]
    fn cpu_has_no_fast_path() {
        let hw = Hardware { total_ram: ram(), gpu: GpuKind::Cpu };
        assert_eq!(hw.fast_budget(), 0);
        assert_eq!(hw.usable_ceiling(), ram() / 100 * 90);
    }

    #[test]
    fn labels_read_clearly() {
        assert_eq!(
            Hardware { total_ram: ram(), gpu: GpuKind::AppleSilicon }.gpu_label(),
            "Apple Silicon"
        );
        assert_eq!(
            Hardware { total_ram: ram(), gpu: GpuKind::Nvidia { vram: 12 * GIB } }.gpu_label(),
            "NVIDIA (12 GB)"
        );
        assert_eq!(Hardware { total_ram: ram(), gpu: GpuKind::Cpu }.gpu_label(), "CPU");
    }

    #[test]
    fn parse_nvidia_smi_reads_first_gpu_mib() {
        // nvidia-smi prints one line per GPU; we take the first, in MiB.
        assert_eq!(parse_nvidia_smi("12288\n8192\n"), Some(12288 * MIB));
    }

    #[test]
    fn parse_nvidia_smi_none_on_garbage() {
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("N/A\n"), None);
    }

    #[test]
    fn apple_silicon_detects_apple_arm64() {
        assert!(apple_silicon_present("Apple M3 Pro", "aarch64"));
        assert!(apple_silicon_present("Apple M1", "arm64"));
    }

    #[test]
    fn apple_silicon_false_on_intel() {
        assert!(!apple_silicon_present("Intel(R) Core(TM) i9", "x86_64"));
        assert!(!apple_silicon_present("Apple", "x86_64")); // Rosetta-reported arch
    }
}
