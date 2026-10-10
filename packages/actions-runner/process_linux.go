package main

import (
	"context"
	"github.com/shirou/gopsutil/v4/process"
)

func processEnvironment(ctx context.Context, p *process.Process) ([]string, error) {
	return p.EnvironWithContext(ctx)
}
