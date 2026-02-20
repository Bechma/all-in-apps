fn main() {
    let protoc_path =
        protoc_bin_vendored::protoc_bin_path().expect("failed to find bundled protoc");
    prost_build::Config::new()
        .protoc_executable(protoc_path)
        .compile_protos(&["proto/notes.proto"], &["proto"])
        .expect("failed to compile notes protobuf schema");
}
