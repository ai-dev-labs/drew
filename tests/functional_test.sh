#!/bin/bash
set -e

# Setup a test environment
TEST_DIR=$(mktemp -d)
mkdir -p "$TEST_DIR/.drew"
cat <<EOF > "$TEST_DIR/test.rs"
fn main() {
    println!("Hello, world!");
}

mod utils {
    fn add(a: i32, b: i32) -> i32 {
        a + b
    }
}
EOF

# Build the project
npm run build

# Run the extract command
node dist/index.js extract "$TEST_DIR"

# Verify the output
if [ ! -f "$TEST_DIR/.drew/spec-map.json" ]; then
    echo "Error: .drew/spec-map.json not found"
    exit 1
fi

# Check if main and add symbols are present
grep -q "main" "$TEST_DIR/.drew/spec-map.json"
grep -q "add" "$TEST_DIR/.drew/spec-map.json"

echo "Functional test passed!"
rm -rf "$TEST_DIR"
