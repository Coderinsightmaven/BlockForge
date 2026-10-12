//go:build windows

package main

import "io/fs"

func chownIfNeeded(string, fs.FileInfo, int, int) error { return nil }
