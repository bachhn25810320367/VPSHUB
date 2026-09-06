//go:build windows

package sysinfo

import (
	"bytes"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32              = syscall.NewLazyDLL("kernel32.dll")
	procGlobalMemoryStatus = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetSystemTimes    = kernel32.NewProc("GetSystemTimes")
	procGetDiskFreeSpace  = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGetTickCount64     = kernel32.NewProc("GetTickCount64")

	prevWinIdle   uint64
	prevWinKernel uint64
	prevWinUser   uint64
	winCPULock    sync.Mutex
)

type memoryStatusEx struct {
	cbSize                  uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

type fileTime struct {
	dwLowDateTime  uint32
	dwHighDateTime uint32
}

func fileTimeToUint64(ft fileTime) uint64 {
	return (uint64(ft.dwHighDateTime) << 32) | uint64(ft.dwLowDateTime)
}

func CollectMetrics(vpsID, name string) (*SystemMetrics, error) {
	now := time.Now().Unix()
	uptimeSec := getWindowsUptime()
	bootTime := now - uptimeSec

	metrics := &SystemMetrics{
		VPSID:     vpsID,
		Name:      name,
		OS:        "windows",
		Timestamp: now,
		BootTime:  bootTime,
		Uptime:    uptimeSec,
	}

	metrics.CPUPercent = getWindowsCPUPercent()
	metrics.Memory = getWindowsMemory()
	metrics.Disk = getWindowsDisk()
	metrics.Network = getWindowsNetwork()

	return metrics, nil
}

func getWindowsUptime() int64 {
	ret, _, _ := procGetTickCount64.Call()
	return int64(ret / 1000)
}

func getWindowsMemory() MemoryInfo {
	var mem memoryStatusEx
	mem.cbSize = uint32(unsafe.Sizeof(mem))

	ret, _, _ := procGlobalMemoryStatus.Call(uintptr(unsafe.Pointer(&mem)))
	if ret == 0 {
		return MemoryInfo{}
	}

	total := mem.ullTotalPhys
	free := mem.ullAvailPhys
	used := uint64(0)
	if total > free {
		used = total - free
	}

	percent := float64(mem.dwMemoryLoad)

	return MemoryInfo{
		Total:   total,
		Used:    used,
		Free:    free,
		Percent: percent,
	}
}

func getWindowsCPUPercent() float64 {
	winCPULock.Lock()
	defer winCPULock.Unlock()

	var idleTime, kernelTime, userTime fileTime
	ret, _, _ := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idleTime)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)
	if ret == 0 {
		return 0.0
	}

	idle := fileTimeToUint64(idleTime)
	kernel := fileTimeToUint64(kernelTime)
	user := fileTimeToUint64(userTime)

	if prevWinKernel == 0 && prevWinUser == 0 {
		prevWinIdle = idle
		prevWinKernel = kernel
		prevWinUser = user
		return 0.0
	}

	deltaIdle := idle - prevWinIdle
	deltaKernel := kernel - prevWinKernel
	deltaUser := user - prevWinUser

	prevWinIdle = idle
	prevWinKernel = kernel
	prevWinUser = user

	totalSys := deltaKernel + deltaUser
	if totalSys == 0 {
		return 0.0
	}

	// On Windows, kernelTime already includes idleTime
	percent := (float64(totalSys-deltaIdle) / float64(totalSys)) * 100.0
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	return percent
}

func getWindowsDisk() DiskInfo {
	pathPtr, err := syscall.UTF16PtrFromString("C:\\")
	if err != nil {
		return DiskInfo{}
	}

	var freeBytesAvailable, totalNumberOfBytes, totalNumberOfFreeBytes uint64
	ret, _, _ := procGetDiskFreeSpace.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		uintptr(unsafe.Pointer(&totalNumberOfBytes)),
		uintptr(unsafe.Pointer(&totalNumberOfFreeBytes)),
	)
	if ret == 0 {
		return DiskInfo{}
	}

	used := uint64(0)
	if totalNumberOfBytes > totalNumberOfFreeBytes {
		used = totalNumberOfBytes - totalNumberOfFreeBytes
	}

	percent := 0.0
	if totalNumberOfBytes > 0 {
		percent = (float64(used) / float64(totalNumberOfBytes)) * 100.0
	}

	return DiskInfo{
		Total:   totalNumberOfBytes,
		Used:    used,
		Free:    totalNumberOfFreeBytes,
		Percent: percent,
	}
}

func getWindowsNetwork() NetworkInfo {
	// Use netstat -e: highly reliable, zero complex C struct alignment bugs, supported across all Windows versions
	cmd := exec.Command("netstat", "-e")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return NetworkInfo{}
	}

	var totalRx uint64
	var totalTx uint64

	lines := strings.Split(out.String(), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Bytes") {
			fields := strings.Fields(trimmed)
			if len(fields) >= 3 {
				rx, _ := strconv.ParseUint(fields[1], 10, 64)
				tx, _ := strconv.ParseUint(fields[2], 10, 64)
				totalRx = rx
				totalTx = tx
				break
			}
		}
	}

	now := time.Now()
	duration := now.Sub(NetTracker.LastTime).Seconds()
	if duration <= 0 {
		duration = 1.0
	}

	var speedRx, speedTx float64
	if NetTracker.LastRx > 0 && totalRx >= NetTracker.LastRx {
		speedRx = float64(totalRx-NetTracker.LastRx) / duration
	}
	if NetTracker.LastTx > 0 && totalTx >= NetTracker.LastTx {
		speedTx = float64(totalTx-NetTracker.LastTx) / duration
	}

	NetTracker.LastRx = totalRx
	NetTracker.LastTx = totalTx
	NetTracker.LastTime = now

	return NetworkInfo{
		BytesRecv:  totalRx,
		BytesSent:  totalTx,
		SpeedRxBps: speedRx,
		SpeedTxBps: speedTx,
	}
}
