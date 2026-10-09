package main

import (
	"context"
	"encoding/binary"
	"github.com/shirou/gopsutil/v4/process"
	"golang.org/x/sys/unix"
	"strings"
)

// gopsutil does not implement Darwin environments. Read only the kernel's
// argument/environment vector; it never leaves the worker or reaches logs.
func processEnvironment(_ context.Context, p *process.Process) ([]string, error) {
	data, err := unix.SysctlRaw("kern.procargs2", int(p.Pid))
	if err != nil || len(data) < 4 {
		return nil, err
	}
	argc := int(binary.NativeEndian.Uint32(data[:4]))
	data = data[4:]
	if argc < 0 || argc > 1<<20 {
		return nil, nil
	}
	text := string(data)
	end := strings.IndexByte(text, 0)
	if end < 0 {
		return nil, nil
	}
	text = text[end+1:]
	text = strings.TrimLeft(text, "\x00")
	for i := 0; i < argc; i++ {
		end = strings.IndexByte(text, 0)
		if end < 0 {
			return nil, nil
		}
		text = text[end+1:]
	}
	return strings.Split(text, "\x00"), nil
}
