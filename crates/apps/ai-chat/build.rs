fn main() {
    let protoc_path =
        protoc_bin_vendored::protoc_bin_path().expect("failed to find bundled protoc");
    prost_build::Config::new()
        .protoc_executable(protoc_path)
        .compile_protos(&["proto/ai_chat.proto"], &["proto"])
        .expect("failed to compile ai-chat protobuf schema");
}
