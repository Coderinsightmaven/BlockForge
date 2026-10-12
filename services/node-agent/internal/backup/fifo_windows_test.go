//go:build windows

package backup

import "errors"

func mkfifo(string) error { return errors.New("unsupported") }
