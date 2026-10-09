.PHONY: build run vet fmt

build:
	go build -o swiftgrok ./cmd/swiftgrok

run: build
	./swiftgrok -config config.json

vet:
	go vet ./...

fmt:
	gofmt -l -w .
