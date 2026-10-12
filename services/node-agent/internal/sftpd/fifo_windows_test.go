//go:build windows

package sftpd

import "errors"

func mkfifo(string) error { return errors.New("unsupported") }
