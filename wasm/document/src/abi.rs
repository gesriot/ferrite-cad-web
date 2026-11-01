//! Synchronous C ABI. Input buffers remain owned by the caller. A response is
//! malloc-owned: u32 LE JSON length, UTF-8 JSON, then optional FCAD bytes.
//! The caller frees it with Emscripten's standard free after copying the frame.
use serde_json::Value;

unsafe fn input<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    if length == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(pointer, length) }
    }
}

unsafe fn output((json, bytes): (Value, Option<Vec<u8>>), length: *mut usize) -> *mut u8 {
    let json = serde_json::to_vec(&json).expect("JSON value is serializable");
    let bytes = bytes.unwrap_or_default();
    let size = 4 + json.len() + bytes.len();
    let pointer = unsafe { libc::malloc(size) as *mut u8 };
    if pointer.is_null() {
        unsafe { *length = 0 };
        return pointer;
    }
    unsafe {
        std::ptr::copy_nonoverlapping((json.len() as u32).to_le_bytes().as_ptr(), pointer, 4);
        std::ptr::copy_nonoverlapping(json.as_ptr(), pointer.add(4), json.len());
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.add(4 + json.len()), bytes.len());
        *length = size;
    }
    pointer
}

// Safety: all pointers refer to live, non-overlapping allocations in this
// module's memory; the caller supplies their exact byte lengths and a u32 out.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fcad_open(bytes: *const u8, size: usize, length: *mut usize) -> *mut u8 {
    unsafe { output(crate::facade::open(input(bytes, size)), length) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn fcad_set_expression(
    bytes: *const u8,
    size: usize,
    request: *const u8,
    request_size: usize,
    length: *mut usize,
) -> *mut u8 {
    unsafe {
        output(
            crate::facade::set_expression(input(bytes, size), input(request, request_size)),
            length,
        )
    }
}
