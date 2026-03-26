package protoutil

import (
	"bytes"
	"io"
	"testing"

	registrypb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"google.golang.org/protobuf/proto"
)

func TestWriteReadDelimited_RoundTrip(t *testing.T) {
	want := &registrypb.ModuleMetadata{
		Homepage: "https://example.com",
	}

	var buf bytes.Buffer
	if err := WriteDelimitedTo(want, &buf); err != nil {
		t.Fatal(err)
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadDelimitedFrom(got, &buf); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(want, got) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestWriteReadDelimited_Multiple(t *testing.T) {
	msgs := []*registrypb.ModuleMetadata{
		{Homepage: "https://one.com"},
		{Homepage: "https://two.com"},
		{Homepage: "https://three.com"},
	}

	var buf bytes.Buffer
	for _, msg := range msgs {
		if err := WriteDelimitedTo(msg, &buf); err != nil {
			t.Fatal(err)
		}
	}

	reader := bytes.NewReader(buf.Bytes())
	for i, want := range msgs {
		got := &registrypb.ModuleMetadata{}
		if err := ReadDelimitedFrom(got, reader); err != nil {
			t.Fatalf("message %d: %v", i, err)
		}
		if !proto.Equal(want, got) {
			t.Errorf("message %d: got %v, want %v", i, got, want)
		}
	}

	// Should get EOF after all messages are read
	got := &registrypb.ModuleMetadata{}
	if err := ReadDelimitedFrom(got, reader); err != io.EOF {
		t.Errorf("expected io.EOF after all messages, got %v", err)
	}
}

func TestReadDelimitedFrom_EOF(t *testing.T) {
	reader := bytes.NewReader(nil)
	got := &registrypb.ModuleMetadata{}
	if err := ReadDelimitedFrom(got, reader); err != io.EOF {
		t.Errorf("expected io.EOF, got %v", err)
	}
}

func TestReadDelimitedFrom_Truncated(t *testing.T) {
	want := &registrypb.ModuleMetadata{
		Homepage: "https://example.com",
	}

	var buf bytes.Buffer
	if err := WriteDelimitedTo(want, &buf); err != nil {
		t.Fatal(err)
	}

	// Truncate the data (keep varint header but cut the message short)
	data := buf.Bytes()
	truncated := data[:len(data)/2]
	reader := bytes.NewReader(truncated)

	got := &registrypb.ModuleMetadata{}
	if err := ReadDelimitedFrom(got, reader); err == nil {
		t.Fatal("expected error for truncated data")
	}
}
