package fsops

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSettleWaitAndContinuousChanges(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	recent := fileID{ctime: now.Add(-5 * time.Millisecond).UnixNano()}
	if recent.settleWait(now) != ctimeSettle-5*time.Millisecond {
		t.Fatal("a change younger than ctimeSettle must be waited out")
	}
	for _, old := range []fileID{{ctime: now.Add(-time.Second).UnixNano()}, {ctime: now.Add(time.Hour).UnixNano()}, {}} {
		if old.settleWait(now) != 0 {
			t.Fatalf("%+v must not wait", old)
		}
	}
	// chmod (even to the same mode) sets ctime: identity includes it, and dev/ino.
	_, data, _ := newRoot(t)
	put(t, data, "f", "x")
	p := filepath.Join(data, "f")
	before, _ := os.Stat(p)
	time.Sleep(2 * ctimeSettle)
	os.Chmod(p, 0o644)
	after, _ := os.Stat(p)
	if idOf(before).same(idOf(after)) || idOf(after).ino == 0 || idOf(after).dev == 0 {
		t.Fatal("chmod did not change the identity")
	}
	// A file that keeps changing never settles.
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
				os.Chmod(p, 0o644)
				time.Sleep(time.Millisecond)
			}
		}
	}()
	_, _, err = settledID(f)
	close(stop)
	<-done
	if err == nil {
		t.Fatal("a continuously changing file must not settle")
	}
}
