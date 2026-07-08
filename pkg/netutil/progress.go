package netutil

import (
	"io"
	"os"

	"github.com/schollz/progressbar/v3"
	"golang.org/x/term"
)

// Interactive reports whether animated progress output is appropriate: stderr
// is a terminal and we are not running in CI. Progress bars animate on every
// update, which is noise in non-interactive logs, so callers should render a
// single summary line instead when this returns false.
func Interactive() bool {
	if os.Getenv("CI") != "" {
		return false
	}
	return term.IsTerminal(int(os.Stderr.Fd()))
}

// NewProgressBar returns the shared-themed animated progress bar when
// Interactive(), otherwise a silent no-op bar that renders nothing. The
// returned bar is always safe to call Add/Finish on, so call sites need no
// branching of their own.
func NewProgressBar(desc string, total int) *progressbar.ProgressBar {
	if !Interactive() {
		return progressbar.NewOptions(total,
			progressbar.OptionSetVisibility(false),
			progressbar.OptionSetWriter(io.Discard),
		)
	}
	return progressbar.NewOptions(total,
		progressbar.OptionSetDescription(desc),
		progressbar.OptionShowCount(),
		progressbar.OptionSetWidth(40),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "=",
			SaucerHead:    ">",
			SaucerPadding: " ",
			BarStart:      "[",
			BarEnd:        "]",
		}),
	)
}
