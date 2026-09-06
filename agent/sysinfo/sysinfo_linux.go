//go:build linux

package sysinfo

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	prevCPUTotal uint64
	prevCPUIdle  uint64
	cpuLock      sync.Mutex
)

func CollectMetrics(vpsID, name string) (*SystemMetrics, error) {
	now := time.Now().Unix()
	bootTime, uptime := getLinuxBootTimeAndUptime()

	metrics := &SystemMetrics{
		VPSID:     vpsID,
		Name:      name,
		OS:        "linux",
		Timestamp: now,
		BootTime:  bootTime,
		Uptime:    uptime,
	}

	metrics.CPUPercent = getLinuxCPUPercent()
	metrics.Memory = getLinuxMemory()
	metrics.Disk = getLinuxDisk()
	metrics.Network = getLinuxNetwork()

	return metrics, nil
}

func getLinuxBootTimeAndUptime() (int64, int64) {
	var bootTime int64
	if file, err := os.Open("/proc/stat"); err == nil {
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "btime ") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if bt, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
						bootTime = bt
						break
					}
				}
			}
		}
		file.Close()
	}

	var uptimeSec int64
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			if upF, err := strconv.ParseFloat(fields[0], 64); err == nil {
				uptimeSec = int64(upF)
			}
		}
	}

	now := time.Now().Unix()
	if bootTime == 0 && uptimeSec > 0 {
		bootTime = now - uptimeSec
	} else if bootTime > 0 && uptimeSec == 0 {
		uptimeSec = now - bootTime
	}

	return bootTime, uptimeSec
}

func getLinuxCPUPercent() float64 {
	cpuLock.Lock()
	defer cpuLock.Unlock()

	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0.0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		return 0.0
	}

	fields := strings.Fields(scanner.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0.0
	}

	var total uint64
	var idle uint64

	for i := 1; i < len(fields); i++ {
		val, _ := strconv.ParseUint(fields[i], 10, 64)
		total += val
		if i == 4 || i == 5 { // idle and iowait
			idle += val
		}
	}

	if prevCPUTotal == 0 {
		prevCPUTotal = total
		prevCPUIdle = idle
		return 0.0
	}

	deltaTotal := total - prevCPUTotal
	deltaIdle := idle - prevCPUIdle

	prevCPUTotal = total
	prevCPUIdle = idle

	if deltaTotal == 0 {
		return 0.0
	}

	percent := (1.0 - float64(deltaIdle)/float64(deltaTotal)) * 100.0
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	return percent
}

func getLinuxMemory() MemoryInfo {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return MemoryInfo{}
	}
	defer file.Close()

	var memTotal, memFree, memAvailable, buffers, cached uint64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Split(line, ":")
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valParts := strings.Fields(strings.TrimSpace(parts[1]))
		if len(valParts) == 0 {
			continue
		}
		valKb, _ := strconv.ParseUint(valParts[0], 10, 64)
		valBytes := valKb * 1024

		switch key {
		case "MemTotal":
			memTotal = valBytes
		case "MemFree":
			memFree = valBytes
		case "MemAvailable":
			memAvailable = valBytes
		case "Buffers":
			buffers = valBytes
		case "Cached":
			cached = valBytes
		}
	}

	var used uint64
	var free uint64

	if memAvailable > 0 {
		free = memAvailable
		if memTotal > memAvailable {
			used = memTotal - memAvailable
		}
	} else {
		// Fallback for older kernels
		free = memFree + buffers + cached
		if memTotal > free {
			used = memTotal - free
		}
	}

	percent := 0.0
	if memTotal > 0 {
		percent = (float64(used) / float64(memTotal)) * 100.0
	}

	return MemoryInfo{
		Total:   memTotal,
		Used:    used,
		Free:    free,
		Percent: percent,
	}
}

func getLinuxDisk() DiskInfo {
	var stat syscall.Statfs_t
	err := syscall.Statfs("/", &stat)
	if err != nil {
		return DiskInfo{}
	}

	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	used := uint64(0)
	if total > free {
		used = total - free
	}

	percent := 0.0
	if total > 0 {
		percent = (float64(used) / float64(total)) * 100.0
	}

	return DiskInfo{
		Total:   total,
		Used:    used,
		Free:    free,
		Percent: percent,
	}
}

func getLinuxNetwork() NetworkInfo {
	file, err := os.Open("/proc/net/dev")
	if err != nil {
		return NetworkInfo{}
	}
	defer file.Close()

	var totalRx uint64
	var totalTx uint64

	scanner := bufio.NewScanner(file)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		if lineNum <= 2 {
			continue // skip header lines
		}

		line := scanner.Text()
		colonIdx := strings.Index(line, ":")
		if colonIdx == -1 {
			continue
		}

		iface := strings.TrimSpace(line[:colonIdx])
		if iface == "lo" {
			continue // skip loopback interface
		}

		fields := strings.Fields(line[colonIdx+1:])
		if len(fields) >= 9 {
			rx, _ := strconv.ParseUint(fields[0], 10, 64)
			tx, _ := strconv.ParseUint(fields[8], 10, 64)
			totalRx += rx
			totalTx += tx
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
