//! Generic ABI 2.20 procedure transport. No diagnostic formula lives here.
use super::*;
use std::collections::BTreeMap;
use std::ffi::CString;
use std::ptr;

#[repr(C)]
struct FitInputs {
    struct_size: u32,
    x: *const MatrixView,
    y: *const MatrixView,
    labels: *const i64,
    n_labels: i64,
    sample_weight: *const f64,
    n_sample_weight: i64,
    groups: *const i64,
    n_groups: i64,
    feature_groups: *const i64,
    n_feature_groups: i64,
    block_sizes: *const i64,
    n_blocks: i64,
    axis: *const f64,
    n_axis: i64,
    x_target: *const MatrixView,
    fold_ids: *const i64,
    n_fold_ids: i64,
}

type Find = unsafe extern "C" fn(*const c_char, *mut i32) -> i32;
type ParamsCreate = unsafe extern "C" fn(*mut c_void, i32, *mut *mut c_void) -> i32;
type SetInt = unsafe extern "C" fn(*mut c_void, *const c_char, i64) -> i32;
type SetDouble = unsafe extern "C" fn(*mut c_void, *const c_char, f64) -> i32;
type SetBool = unsafe extern "C" fn(*mut c_void, *const c_char, i32) -> i32;
type SetEnum = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
type SetInts = unsafe extern "C" fn(*mut c_void, *const c_char, *const i64, i64) -> i32;
type SetDoubles = unsafe extern "C" fn(*mut c_void, *const c_char, *const f64, i64) -> i32;
type Validate = unsafe extern "C" fn(*mut c_void, *const c_void) -> i32;
type Run = unsafe extern "C" fn(
    *mut c_void,
    i32,
    *const c_void,
    *const FitInputs,
    *mut *mut c_void,
) -> i32;
type Count = unsafe extern "C" fn(*const c_void, *mut i32) -> i32;
type Entry = unsafe extern "C" fn(*const c_void, i32, *mut *const c_char, *mut i32) -> i32;
type Matrix =
    unsafe extern "C" fn(*const c_void, *const c_char, *mut *const f64, *mut i64, *mut i64) -> i32;
type Ints = unsafe extern "C" fn(*const c_void, *const c_char, *mut *const i32, *mut i32) -> i32;
type Int64s = unsafe extern "C" fn(*const c_void, *const c_char, *mut *const i64, *mut i64) -> i32;
type Scalar = unsafe extern "C" fn(*const c_void, *const c_char, *mut f64) -> i32;

struct OwnedHandle {
    ptr: *mut c_void,
    destroy: Destroy,
}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this guard owns a non-null handle returned by the matching
        // constructor; the provider's library outlives the guard.
        unsafe { (self.destroy)(self.ptr) }
    }
}

fn cstring(text: &str) -> Result<CString, ProviderError> {
    CString::new(text).map_err(|_| ProviderError::internal("PROCEDURE_INVALID_NAME"))
}

fn bounded_len(n: i64) -> Result<usize, ProviderError> {
    usize::try_from(n)
        .ok()
        .filter(|n| *n <= 10_000_000)
        .ok_or_else(|| ProviderError::internal("PROCEDURE_INVALID_RESULT_SHAPE"))
}

unsafe fn copy_values<T: Copy>(p: *const T, len: usize) -> Result<Vec<T>, ProviderError> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if p.is_null() {
        return Err(ProviderError::internal("PROCEDURE_NULL_RESULT"));
    }
    // SAFETY: the checked Methods ABI promises len elements in this borrowed
    // result entry. Copy while the owning result is alive.
    Ok(unsafe { std::slice::from_raw_parts(p, len) }.to_vec())
}

fn finite(values: &[f64]) -> Result<(), ProviderError> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err(ProviderError::internal("PROCEDURE_NONFINITE_RESULT"))
    }
}

impl NativeMethodsProvider {
    pub(super) fn run_procedure(
        &self,
        r: &ProcedureRequest,
    ) -> Result<ProcedureDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        let x_view = MatrixView::new(&mut x, n, p);
        let mut reference = r.reference.as_ref().map(|x| flatten(x)).transpose()?;
        if reference.as_ref().is_some_and(|(_, _, cols)| *cols != p) {
            return Err(ProviderError::internal(
                "PROCEDURE_REFERENCE_WIDTH_MISMATCH",
            ));
        }
        let reference_view = reference
            .as_mut()
            .map(|(x, n, p)| MatrixView::new(x, *n, *p));
        let inputs = FitInputs {
            struct_size: std::mem::size_of::<FitInputs>() as u32,
            x: &x_view,
            y: ptr::null(),
            labels: ptr::null(),
            n_labels: 0,
            sample_weight: ptr::null(),
            n_sample_weight: 0,
            groups: ptr::null(),
            n_groups: 0,
            feature_groups: ptr::null(),
            n_feature_groups: 0,
            block_sizes: ptr::null(),
            n_blocks: 0,
            axis: ptr::null(),
            n_axis: 0,
            x_target: reference_view.as_ref().map_or(ptr::null(), |v| v),
            fold_ids: ptr::null(),
            n_fold_ids: 0,
        };
        // SAFETY: all symbols are resolved from the checked, live ABI 2.20
        // library. Inputs and typed parameter buffers remain alive through run.
        unsafe {
            macro_rules! symbol {
                ($name:literal, $ty:ty) => {
                    *self
                        ._library
                        .get::<$ty>(concat!($name, "\0").as_bytes())
                        .map_err(|_| ProviderError::unsupported("PROCEDURE_ABI_SYMBOL_MISSING"))?
                };
            }
            let find = symbol!("n4m_method_find", Find);
            let create = symbol!("n4m_params_create", ParamsCreate);
            let destroy_params = symbol!("n4m_params_destroy", Destroy);
            let destroy_result = symbol!("n4m_method_result_destroy", Destroy);
            let validate = symbol!("n4m_params_validate", Validate);
            let run = symbol!("n4m_procedure_run", Run);
            let mut method_index = -1;
            let status = find(cstring(&r.method_id)?.as_ptr(), &mut method_index);
            if status != 0 {
                return Err(ProviderError::unsupported("METHODS_PROCEDURE_UNAVAILABLE")
                    .with_detail(r.method_id.clone()));
            }
            let mut params = ptr::null_mut();
            self.check(create(self.context, method_index, &mut params))?;
            if params.is_null() {
                return Err(ProviderError::internal("PROCEDURE_NULL_PARAMS"));
            }
            let params = OwnedHandle {
                ptr: params,
                destroy: destroy_params,
            };
            for (name, value) in &r.parameters {
                let key = cstring(name)?;
                let status = match value {
                    ProcedureParameter::Int(v) => {
                        symbol!("n4m_params_set_int", SetInt)(params.ptr, key.as_ptr(), *v)
                    }
                    ProcedureParameter::Double(v) if v.is_finite() => {
                        symbol!("n4m_params_set_double", SetDouble)(params.ptr, key.as_ptr(), *v)
                    }
                    ProcedureParameter::Bool(v) => symbol!("n4m_params_set_bool", SetBool)(
                        params.ptr,
                        key.as_ptr(),
                        i32::from(*v),
                    ),
                    ProcedureParameter::Enum(v) => symbol!("n4m_params_set_enum", SetEnum)(
                        params.ptr,
                        key.as_ptr(),
                        cstring(v)?.as_ptr(),
                    ),
                    ProcedureParameter::IntArray(v) if v.len() <= 10_000_000 => {
                        symbol!("n4m_params_set_int_array", SetInts)(
                            params.ptr,
                            key.as_ptr(),
                            v.as_ptr(),
                            v.len() as i64,
                        )
                    }
                    ProcedureParameter::DoubleArray(v)
                        if v.len() <= 10_000_000 && v.iter().all(|v| v.is_finite()) =>
                    {
                        symbol!("n4m_params_set_double_array", SetDoubles)(
                            params.ptr,
                            key.as_ptr(),
                            v.as_ptr(),
                            v.len() as i64,
                        )
                    }
                    _ => return Err(ProviderError::internal("PROCEDURE_INVALID_PARAMETER_VALUE")),
                };
                if status != 0 {
                    return Err(ProviderError::internal("PROCEDURE_INVALID_PARAMETER")
                        .with_detail(name.clone()));
                }
            }
            self.check(validate(self.context, params.ptr))?;
            let mut result = ptr::null_mut();
            let status = run(self.context, method_index, params.ptr, &inputs, &mut result);
            // Keep any error-path allocation owned as well.
            let result = (!result.is_null()).then(|| OwnedHandle {
                ptr: result,
                destroy: destroy_result,
            });
            self.check(status)?;
            let result = result.ok_or_else(|| ProviderError::internal("PROCEDURE_NULL_RESULT"))?;
            let count = symbol!("n4m_method_result_entry_count", Count);
            let entry = symbol!("n4m_method_result_entry", Entry);
            let matrix = symbol!("n4m_method_result_get_double_matrix", Matrix);
            let ints = symbol!("n4m_method_result_get_int_vector", Ints);
            let int64s = symbol!("n4m_method_result_get_int64_vector", Int64s);
            let scalar = symbol!("n4m_method_result_get_scalar", Scalar);
            let mut n_entries = 0;
            self.check(count(result.ptr, &mut n_entries))?;
            if !(0..=4096).contains(&n_entries) {
                return Err(ProviderError::internal("PROCEDURE_INVALID_ENTRY_COUNT"));
            }
            let mut outputs = BTreeMap::new();
            for index in 0..n_entries {
                let mut name = ptr::null();
                let mut kind = -1;
                self.check(entry(result.ptr, index, &mut name, &mut kind))?;
                if name.is_null() {
                    return Err(ProviderError::internal("PROCEDURE_INVALID_RESULT_NAME"));
                }
                let key = CStr::from_ptr(name)
                    .to_str()
                    .map_err(|_| ProviderError::internal("PROCEDURE_INVALID_RESULT_NAME"))?
                    .to_owned();
                let value = match kind {
                    0 => {
                        let (mut data, mut rows, mut cols) = (ptr::null(), 0, 0);
                        self.check(matrix(result.ptr, name, &mut data, &mut rows, &mut cols))?;
                        let rows = bounded_len(rows)?;
                        let cols = bounded_len(cols)?;
                        let len = rows
                            .checked_mul(cols)
                            .filter(|n| *n <= 10_000_000)
                            .ok_or_else(|| {
                                ProviderError::internal("PROCEDURE_INVALID_RESULT_SHAPE")
                            })?;
                        let data = copy_values(data, len)?;
                        finite(&data)?;
                        ProcedureOutput::Matrix { rows, cols, data }
                    }
                    1 => {
                        let (mut data, mut len) = (ptr::null(), 0);
                        self.check(ints(result.ptr, name, &mut data, &mut len))?;
                        let data = copy_values(data, bounded_len(i64::from(len))?)?
                            .into_iter()
                            .map(i64::from)
                            .collect();
                        ProcedureOutput::IntegerVector { data }
                    }
                    2 => {
                        let (mut data, mut len) = (ptr::null(), 0);
                        self.check(int64s(result.ptr, name, &mut data, &mut len))?;
                        ProcedureOutput::IntegerVector {
                            data: copy_values(data, bounded_len(len)?)?,
                        }
                    }
                    3 => {
                        let mut value = 0.;
                        self.check(scalar(result.ptr, name, &mut value))?;
                        finite(&[value])?;
                        ProcedureOutput::Scalar { value }
                    }
                    _ => {
                        return Err(ProviderError::unsupported(
                            "PROCEDURE_RESULT_KIND_UNSUPPORTED",
                        ))
                    }
                };
                if outputs.insert(key, value).is_some() {
                    return Err(ProviderError::internal("PROCEDURE_DUPLICATE_RESULT_NAME"));
                }
            }
            Ok(ProcedureDiagnostics {
                outputs,
                backend_version: self.version.clone(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_abi_layout_matches_v1_header() {
        assert_eq!(std::mem::size_of::<FitInputs>(), 144);
        assert_eq!(std::mem::offset_of!(FitInputs, x), 8);
        assert_eq!(std::mem::offset_of!(FitInputs, x_target), 120);
        assert_eq!(std::mem::offset_of!(FitInputs, n_fold_ids), 136);
        assert_eq!(std::mem::size_of::<MatrixView>(), 48);
    }
}
