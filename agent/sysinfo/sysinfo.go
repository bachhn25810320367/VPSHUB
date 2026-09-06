package sysinfo

import "time"

type MemoryInfo struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Free    uint64  `json:"free"`
	Percent float64 `json:"percent"`
}

type DiskInfo struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Free    uint64  `json:"free"`
	Percent float64 `json:"percent"`
}

type NetworkInfo struct {
	BytesRecv  uint64  `json:"bytes_recv"`
	BytesSent  uint64  `json:"bytes_sent"`
	SpeedRxBps float64 `json:"speed_rx_bps"`
	SpeedTxBps float64 `json:"speed_tx_bps"`
}

type ContainerItem struct {
	Name    string  `json:"name"`
	CPU     float64 `json:"cpu"`
	Memory  float64 `json:"memory"` // in MB
	Network string  `json:"network"`
	Health  string  `json:"health"`
	Ports   string  `json:"ports"`
	Image   string  `json:"image"`
	Status  string  `json:"status"`
	Updated string  `json:"updated"`
}

type ServiceItem struct {
	Name     string  `json:"name"`
	Status   string  `json:"status"`
	Substate string  `json:"substate"`
	CPU      float64 `json:"cpu"`
	Memory   float64 `json:"memory"` // in MB
	Updated  string  `json:"updated"`
}

type DiskIOInfo struct {
	ReadSpeedBps  float64 `json:"read_speed_bps"`
	WriteSpeedBps float64 `json:"write_speed_bps"`
}

type SystemMetrics struct {
	VPSID          string          `json:"vps_id"`
	Name           string          `json:"name"`
	OS             string          `json:"os"`
	Timestamp      int64           `json:"timestamp"`
	BootTime       int64           `json:"boot_time"`
	Uptime         int64           `json:"uptime"`
	CPUPercent     float64         `json:"cpu_percent"`
	Memory         MemoryInfo      `json:"memory"`
	Swap           MemoryInfo      `json:"swap"`
	Disk           DiskInfo        `json:"disk"`
	DiskIO         DiskIOInfo      `json:"disk_io"`
	Network        NetworkInfo     `json:"network"`
	LoadAvg        [3]float64      `json:"load_avg"`
	DockerCPU      float64         `json:"docker_cpu"`
	DockerMemoryMB float64         `json:"docker_memory_mb"`
	Containers     []ContainerItem `json:"containers"`
	Services       []ServiceItem   `json:"services"`
}

// Global state to compute CPU and network deltas
type NetDeltaTracker struct {
	LastRx   uint64
	LastTx   uint64
	LastTime time.Time
}

var NetTracker = &NetDeltaTracker{
	LastTime: time.Now(),
}
