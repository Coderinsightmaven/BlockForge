//go:build windows

package fsops

import "errors"

func mkfifo(string) error { return errors.New("unsupported") }
