package main

import (
	"archive/tar"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	archive "github.com/moby/go-archive"
	"github.com/moby/sys/user"
)

func TestArchiveExtractionCannotFollowLinksOutsideDestination(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "extract")
	outside := filepath.Join(root, "outside")
	for _, directory := range []string{destination, outside} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// Exercise the two-hop link case from the upstream security regression:
	// https://github.com/moby/go-archive/blob/v0.3.0/archive_test.go
	var data bytes.Buffer
	writer := tar.NewWriter(&data)
	for _, header := range []*tar.Header{
		{Name: "directory", Typeflag: tar.TypeDir, Mode: 0o700},
		{Name: "directory/parent", Typeflag: tar.TypeSymlink, Linkname: ".."},
		{Name: "directory/parent/link", Typeflag: tar.TypeSymlink, Linkname: "../outside"},
		{Name: "directory/parent/link/escaped", Typeflag: tar.TypeReg, Mode: 0o600},
	} {
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	// Rejection or confined extraction are both safe; neither may touch outside.
	_ = archive.Untar(&data, destination, &archive.TarOptions{NoLchown: true})
	if _, err := os.Lstat(filepath.Join(outside, "escaped")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("archive wrote outside its destination, or could not verify confinement: %v", err)
	}
}

func TestContainerGroupParserBoundsUntrustedEntries(t *testing.T) {
	groups, err := user.ParseGroup(strings.NewReader("runner:x:1000:alice,bob\n"))
	if err != nil || len(groups) != 1 || len(groups[0].List) != 2 {
		t.Fatalf("normal container groups must remain usable: %v, %v", groups, err)
	}
	// A finite, small fixture exercises the bound without risking an OOM.
	_, err = user.ParseGroup(strings.NewReader("runner:x:1000:" + strings.Repeat("a", 2*1024*1024)))
	if err == nil {
		t.Fatal("oversized untrusted container group entry was accepted")
	}
}
