pub mod build {
    pub mod bazel {
        pub mod remote {
            pub mod execution {
                pub mod v2 {
                    include!("build.bazel.remote.execution.v2.rs");
                }
            }
        }

        pub mod semver {
            include!("build.bazel.semver.rs");
        }
    }

    pub mod stack {
        pub mod bazel {
            pub mod remoteexecution {
                pub mod v1 {
                    include!("build.stack.bazel.remoteexecution.v1.rs");
                }
            }
        }
    }
}

pub mod google {
    pub mod longrunning {
        include!("google.longrunning.rs");
    }

    pub mod rpc {
        include!("google.rpc.rs");
    }
}

pub use build::{
    bazel::remote::execution::v2 as reapi, stack::bazel::remoteexecution::v1 as worker,
};
