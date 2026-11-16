# MinIO is source-only; build the pinned official release instead of removed images.
FROM golang:1.24.8-bookworm AS build
RUN CGO_ENABLED=0 GOMAXPROCS=4 go install github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
    && mkdir /data
FROM scratch
COPY --from=build /go/bin/minio /minio
COPY --from=build --chown=65532:65532 /data /data
ENV HOME=/data
USER 65532:65532
ENTRYPOINT ["/minio"]
