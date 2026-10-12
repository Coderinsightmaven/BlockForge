// Package version holds build metadata, overridable with -ldflags "-X".
package version

// Version is the agent semantic version reported in enrollment and hello frames.
var Version = "0.1.0"

// Commit is the source revision the binary was built from.
var Commit = "dev"
