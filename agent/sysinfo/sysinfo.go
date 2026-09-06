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

type SystemMetrics struct {
	VPSID      string      `json:"vps_id"`
	Name       string      `json:"name"`
	OS         string      `json:"os"`
	Timestamp  int64       `json:"timestamp"`
	CPUPercent float64     `json:"cpu_percent"`
	Memory     MemoryInfo  `json:"memory"`
	Disk       DiskInfo    `json:"disk"`
	Network    NetworkInfo `json:"network"`
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
