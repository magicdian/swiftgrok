BINARY := swiftgrok
SOURCES := sources

.PHONY: build run vet fmt test

build:
	cd $(SOURCES) && go build -o ../$(BINARY) ./cmd/swiftgrok

run: build
	./$(BINARY) -config config.json

vet:
	cd $(SOURCES) && go vet ./...

fmt:
	cd $(SOURCES) && gofmt -l -w .
