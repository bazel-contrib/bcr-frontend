package remotecache

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"strings"

	bs "google.golang.org/genproto/googleapis/bytestream"
	"google.golang.org/grpc"
)

// BlobArchive uses REAPI ByteStream to store opaque SHA-256 blobs in one instance.
type BlobArchive struct {
	client bs.ByteStreamClient
	prefix string
}

func NewBlobArchive(conn grpc.ClientConnInterface, instance string) (*BlobArchive, error) {
	if instance == "" {
		return nil, errors.New("an archive cache instance is required")
	}
	for _, part := range strings.Split(instance, "/") {
		switch part {
		case "", ".", "..", "blobs", "uploads", "actions", "actionResults", "operations", "capabilities", "compressed-blobs":
			return nil, errors.New("invalid archive cache instance")
		}
		if strings.ContainsAny(part, "?#% \\\t\n\r") {
			return nil, errors.New("invalid archive cache instance")
		}
	}
	return &BlobArchive{client: bs.NewByteStreamClient(conn), prefix: instance + "/"}, nil
}

func (a *BlobArchive) Put(ctx context.Context, digest string, blob []byte) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	uuid := fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	resource := fmt.Sprintf("%suploads/%s/blobs/%s/%d", a.prefix, uuid, digest, len(blob))
	stream, err := a.client.Write(ctx)
	if err != nil {
		return err
	}
	for offset := 0; offset < len(blob); {
		end := min(offset+(1<<20), len(blob))
		req := &bs.WriteRequest{WriteOffset: int64(offset), Data: blob[offset:end], FinishWrite: end == len(blob)}
		if offset == 0 {
			req.ResourceName = resource
		}
		if err := stream.Send(req); errors.Is(err, io.EOF) {
			break // The server may already have the blob.
		} else if err != nil {
			return err
		}
		offset = end
	}
	result, err := stream.CloseAndRecv()
	if err != nil {
		return err
	}
	if result.GetCommittedSize() != int64(len(blob)) {
		return errors.New("archive upload returned an unexpected committed size")
	}
	return nil
}

func (a *BlobArchive) Get(ctx context.Context, digest string, size int64) ([]byte, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := a.client.Read(ctx, &bs.ReadRequest{ResourceName: fmt.Sprintf("%sblobs/%s/%d", a.prefix, digest, size)})
	if err != nil {
		return nil, err
	}
	var blob bytes.Buffer
	for {
		reply, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return blob.Bytes(), nil
		}
		if err != nil {
			return nil, err
		}
		if int64(blob.Len())+int64(len(reply.GetData())) > size {
			return nil, errors.New("archive download exceeds the declared size")
		}
		blob.Write(reply.GetData())
	}
}
