package protoutil

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type marshaler func(m protoreflect.ProtoMessage) ([]byte, error)
type unmarshaler func(b []byte, m protoreflect.ProtoMessage) error

func unmarshalerForFilename(filename string) (unmarshaler, string) {
	if filepath.Ext(filename) == ".json" {
		return protojson.Unmarshal, "json"
	}
	if filepath.Ext(filename) == ".text" || filepath.Ext(filename) == ".pbtext" || filepath.Ext(filename) == ".textproto" {
		return prototext.Unmarshal, "text"
	}
	return proto.Unmarshal, "proto"
}

func marshalerForFilename(filename string) marshaler {
	if filepath.Ext(filename) == ".json" {
		return protojson.Marshal
	}
	if filepath.Ext(filename) == ".textproto" {
		return prototext.Marshal
	}
	return proto.Marshal
}

func ReadFile(filename string, message protoreflect.ProtoMessage) error {
	data, err := os.ReadFile(filename)
	if err != nil {
		return fmt.Errorf("read %q: %w", filename, err)
	}
	formatName := filename
	if inner, ok := strings.CutSuffix(filename, ".gz"); ok {
		gr, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("gzip open %q: %w", filename, err)
		}
		data, err = io.ReadAll(gr)
		if err != nil {
			return fmt.Errorf("gzip read %q: %w", filename, err)
		}
		gr.Close()
		formatName = inner
	}
	unmarshaler, name := unmarshalerForFilename(formatName)
	if err := unmarshaler(data, message); err != nil {
		return fmt.Errorf("unmarshal %q: %w", name, err)
	}
	return nil
}

func WriteFile(filename string, message protoreflect.ProtoMessage) error {
	formatName, gz := strings.CutSuffix(filename, ".gz")
	data, err := marshalerForFilename(formatName)(message)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	if gz {
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		if _, err := gw.Write(data); err != nil {
			return fmt.Errorf("gzip write: %w", err)
		}
		if err := gw.Close(); err != nil {
			return fmt.Errorf("gzip close: %w", err)
		}
		data = buf.Bytes()
	}
	if err := os.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

func WritePrettyJSONFile(filename string, message protoreflect.ProtoMessage) error {
	marshaler := protojson.MarshalOptions{
		Multiline:       true,
		Indent:          "  ",
		EmitUnpopulated: false,
	}
	data, err := marshaler.Marshal(message)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	if err := os.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

func WritePrettyTextFile(filename string, message protoreflect.ProtoMessage) error {
	marshaler := prototext.MarshalOptions{
		Multiline: true,
		EmitASCII: true,
	}
	data, err := marshaler.Marshal(message)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	if err := os.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

func FormatProtoText(message protoreflect.ProtoMessage) string {
	marshaler := prototext.MarshalOptions{
		Multiline: true,
		EmitASCII: true,
	}
	return marshaler.Format(message)
}
