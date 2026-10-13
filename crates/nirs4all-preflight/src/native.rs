//! Thin adapter to the public Methods ABI. No scientific kernels live here.
use crate::*;
use libloading::Library;
use std::ffi::{c_char, c_void, CStr};
use std::marker::PhantomData;
use std::path::Path;
use std::rc::Rc;

#[repr(C)]
struct MatrixView {
    data: *mut c_void,
    rows: i64,
    cols: i64,
    row_stride: i64,
    col_stride: i64,
    dtype: i32,
    reserved: i32,
}
impl MatrixView {
    fn new(data: &mut [f64], rows: usize, cols: usize) -> Self {
        Self {
            data: data.as_mut_ptr().cast(),
            rows: rows as i64,
            cols: cols as i64,
            row_stride: cols as i64,
            col_stride: 1,
            dtype: 1,
            reserved: 0,
        }
    }
}
type Create = unsafe extern "C" fn(*mut *mut c_void) -> i32;
type Destroy = unsafe extern "C" fn(*mut c_void);
type LastError = unsafe extern "C" fn(*const c_void) -> *const c_char;
type Pca = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    i32,
    *const MatrixView,
    *const MatrixView,
    *mut f64,
    *mut f64,
) -> i32;
type Repeats = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    *const u8,
    *mut f64,
    *mut f64,
    *mut i64,
    *mut i32,
) -> i32;
type Summary = unsafe extern "C" fn(*mut c_void, *const f64, *const u8, i64, *mut f64) -> i32;
type LocalContrast = unsafe extern "C" fn(
    *mut c_void,
    *const f64,
    *const i64,
    *const i64,
    i64,
    i32,
    i32,
    *mut f64,
) -> i32;
type Knn = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const MatrixView,
    *const i64,
    *const i64,
    i32,
    *mut i64,
    *mut f64,
) -> i32;
type SnvCreate = unsafe extern "C" fn(*mut *mut c_void, i32, i32, i32) -> i32;
type SnvDestroy = unsafe extern "C" fn(*mut c_void);
type SnvTransform = unsafe extern "C" fn(*const c_void, MatrixView, MatrixView) -> i32;
type NoiseProxy = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const u8,
    i32,
    i32,
    *mut f64,
    *mut i64,
    *mut f64,
) -> i32;
type TolerancePairs = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const MatrixView,
    *const i64,
    *const i64,
    f64,
    i64,
    *mut i64,
    *mut f64,
    *mut u8,
    *mut u8,
    *mut i64,
) -> i32;
type Hdbscan = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    i64,
    i64,
    i32,
    i32,
    *mut i64,
    *mut f64,
    *mut f64,
    *mut i64,
    *mut f64,
    *mut i64,
    *mut i64,
    *mut i64,
    *mut i64,
    *mut f64,
    *mut f64,
    *mut f64,
) -> i32;
type Ari = unsafe extern "C" fn(*mut c_void, *const i64, *const i64, i64, *mut f64) -> i32;

/// Each provider owns one context, and stays on its creating thread.
pub struct NativeMethodsProvider {
    _library: Library,
    context: *mut c_void,
    destroy: Destroy,
    last_error: LastError,
    pca_fn: Pca,
    repeats_fn: Repeats,
    summary_fn: Summary,
    knn_fn: Knn,
    local_fn: LocalContrast,
    hdbscan_fn: Hdbscan,
    ari_fn: Ari,
    snv_create: SnvCreate,
    snv_destroy: SnvDestroy,
    snv_transform: SnvTransform,
    noise_fn: NoiseProxy,
    pairs_fn: TolerancePairs,
    version: String,
    _thread_bound: PhantomData<Rc<()>>,
}
impl NativeMethodsProvider {
    /// Load only an explicitly selected Methods library; no checkout search.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ProviderError> {
        // SAFETY: all symbols are checked before context creation; Library stays
        // alive longer than its function pointers and the owned context.
        unsafe {
            let library = Library::new(path.as_ref())
                .map_err(|_| ProviderError("METHODS_LIBRARY_LOAD_FAILED".into()))?;
            let compat = *library
                .get::<unsafe extern "C" fn(u32, u32) -> i32>(b"n4m_check_abi_compatibility\0")
                .map_err(err)?;
            if compat(2, 19) != 0 {
                return Err(ProviderError("METHODS_ABI_2_19_REQUIRED".into()));
            }
            let create = *library
                .get::<Create>(b"n4m_context_create\0")
                .map_err(err)?;
            let destroy = *library
                .get::<Destroy>(b"n4m_context_destroy\0")
                .map_err(err)?;
            let last_error = *library
                .get::<LastError>(b"n4m_context_last_error\0")
                .map_err(err)?;
            let pca_fn = *library
                .get::<Pca>(b"n4m_preflight_pca_compute\0")
                .map_err(err)?;
            let repeats_fn = *library
                .get::<Repeats>(b"n4m_preflight_repeatability_compute\0")
                .map_err(err)?;
            let summary_fn = *library
                .get::<Summary>(b"n4m_preflight_summary_compute\0")
                .map_err(err)?;
            let knn_fn = *library
                .get::<Knn>(b"n4m_preflight_nearest_neighbors\0")
                .map_err(err)?;
            let local_fn = *library
                .get::<LocalContrast>(b"n4m_preflight_local_contrast\0")
                .map_err(err)?;
            let hdbscan_fn = *library
                .get::<Hdbscan>(b"n4m_cluster_hdbscan\0")
                .map_err(err)?;
            let ari_fn = *library
                .get::<Ari>(b"n4m_preflight_adjusted_rand_index\0")
                .map_err(err)?;
            let snv_create = *library
                .get::<SnvCreate>(b"n4m_transform_snv_create\0")
                .map_err(err)?;
            let snv_destroy = *library
                .get::<SnvDestroy>(b"n4m_transform_snv_destroy\0")
                .map_err(err)?;
            let snv_transform = *library
                .get::<SnvTransform>(b"n4m_transform_snv_transform\0")
                .map_err(err)?;
            let noise_fn = *library
                .get::<NoiseProxy>(b"n4m_preflight_noise_proxy_compute\0")
                .map_err(err)?;
            let pairs_fn = *library
                .get::<TolerancePairs>(b"n4m_preflight_pairs_within_tolerance\0")
                .map_err(err)?;
            let get_version = *library
                .get::<unsafe extern "C" fn() -> *const c_char>(b"n4m_get_version_string\0")
                .map_err(err)?;
            let ptr = get_version();
            let version = if ptr.is_null() {
                "unknown".into()
            } else {
                CStr::from_ptr(ptr).to_string_lossy().into_owned()
            };
            let mut context = std::ptr::null_mut();
            if create(&mut context) != 0 || context.is_null() {
                return Err(ProviderError("METHODS_CONTEXT_CREATE_FAILED".into()));
            }
            Ok(Self {
                _library: library,
                context,
                destroy,
                last_error,
                pca_fn,
                repeats_fn,
                summary_fn,
                knn_fn,
                local_fn,
                snv_create,
                snv_destroy,
                snv_transform,
                noise_fn,
                pairs_fn,
                hdbscan_fn,
                ari_fn,
                version,
                _thread_bound: PhantomData,
            })
        }
    }
    fn check(&self, status: i32) -> Result<(), ProviderError> {
        if status == 0 {
            return Ok(());
        }
        // SAFETY: live provider context; error string copied before next call.
        let _message = unsafe {
            let p = (self.last_error)(self.context);
            if p.is_null() {
                String::new()
            } else {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        };
        Err(ProviderError(format!("METHODS_STATUS_{status}")))
    }
}
fn err(_e: libloading::Error) -> ProviderError {
    ProviderError("METHODS_LIBRARY_LOAD_FAILED".into())
}
fn flatten(matrix: &[Vec<f64>]) -> Result<(Vec<f64>, usize, usize), ProviderError> {
    let n = matrix.len();
    let p = matrix.first().map_or(0, Vec::len);
    if n == 0
        || p == 0
        || matrix
            .iter()
            .any(|row| row.len() != p || row.iter().any(|v| !v.is_finite()))
    {
        return Err(ProviderError("INVALID_PROVIDER_MATRIX".into()));
    }
    if n.checked_mul(p).is_none_or(|cells| cells > 10_000_000) {
        return Err(ProviderError("PROVIDER_MEMORY_BUDGET_EXCEEDED".into()));
    }
    Ok((matrix.iter().flatten().copied().collect(), n, p))
}
impl Drop for NativeMethodsProvider {
    fn drop(&mut self) {
        unsafe {
            (self.destroy)(self.context);
        }
    }
}
impl MethodsProvider for NativeMethodsProvider {
    fn capabilities(&self) -> Vec<Capability> {
        METHODS_CAPABILITY_IDS
            .iter()
            .map(|id| Capability {
                capability_id: (*id).into(),
                available: true,
                qualified: false,
                reason: Some(format!("Methods {} ABI 2.19; alpha protocol", self.version)),
            })
            .collect()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        let k = r.n_components;
        if k == 0 || k > n.min(p) || k > i32::MAX as usize {
            return Err(ProviderError("INVALID_PCA_COMPONENTS".into()));
        }
        let mut scores = vec![0.; n * k];
        let mut loadings = vec![0.; k * p];
        let mut eigenvalues = vec![0.; k];
        let mut full_moments = [0.; 2];
        let xv = MatrixView::new(&mut x, n, p);
        let sv = MatrixView::new(&mut scores, n, k);
        let lv = MatrixView::new(&mut loadings, k, p);
        // SAFETY: all views/outputs have verified dimensions and owned buffers.
        self.check(unsafe {
            (self.pca_fn)(
                self.context,
                &xv,
                k as i32,
                &sv,
                &lv,
                eigenvalues.as_mut_ptr(),
                full_moments.as_mut_ptr(),
            )
        })?;
        Ok(PcaDiagnostics {
            eigenvalues,
            scores: scores.chunks(k).map(<[f64]>::to_vec).collect(),
            full_moments,
            backend_version: self.version.clone(),
        })
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        if r.group_ids.len() != n
            || r.valid_mask.len() != n
            || r.valid_mask.iter().any(|row| row.len() != p)
        {
            return Err(ProviderError("INVALID_REPEATABILITY_SHAPE".into()));
        }
        let mask: Vec<u8> = r
            .valid_mask
            .iter()
            .flatten()
            .map(|v| u8::from(*v))
            .collect();
        let mut sd = vec![f64::NAN; p];
        let mut icc = vec![f64::NAN; p];
        let mut counts = vec![0i64; p];
        let mut status = vec![0; p];
        let xv = MatrixView::new(&mut x, n, p);
        self.check(unsafe {
            (self.repeats_fn)(
                self.context,
                &xv,
                r.group_ids.as_ptr(),
                mask.as_ptr(),
                sd.as_mut_ptr(),
                icc.as_mut_ptr(),
                counts.as_mut_ptr(),
                status.as_mut_ptr(),
            )
        })?;
        Ok(RepeatabilityDiagnostics {
            pooled_sd: sd.into_iter().map(|v| v.is_finite().then_some(v)).collect(),
            icc: icc
                .into_iter()
                .map(|v| v.is_finite().then_some(v))
                .collect(),
            n_complete_groups: counts.into_iter().map(|v| v.max(0) as usize).collect(),
            band_status: status,
            backend_version: self.version.clone(),
        })
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        if r.values.is_empty()
            || r.values.len() > 10_000_000
            || r.values.iter().any(|v| !v.is_finite())
        {
            return Err(ProviderError("INVALID_SUMMARY_VALUES".into()));
        }
        let mut out = [0.; 8];
        self.check(unsafe {
            (self.summary_fn)(
                self.context,
                r.values.as_ptr(),
                std::ptr::null(),
                r.values.len() as i64,
                out.as_mut_ptr(),
            )
        })?;
        Ok(SummaryDiagnostics {
            count: out[0] as usize,
            min: out[1],
            max: out[2],
            mean: out[3],
            sample_sd: out[4].is_finite().then_some(out[4]),
            q25: out[5],
            median: out[6],
            q75: out[7],
            backend_version: self.version.clone(),
        })
    }
    fn nearest_neighbors(
        &self,
        r: &NearestNeighborsRequest,
    ) -> Result<NearestNeighborsDiagnostics, ProviderError> {
        let (mut query, n, p) = flatten(&r.query)?;
        let (mut reference, nr, pr) = flatten(&r.reference)?;
        let k = r.k;
        if pr != p
            || r.query_group_ids.len() != n
            || r.reference_group_ids.len() != nr
            || k == 0
            || k > 100
            || n.checked_mul(nr)
                .and_then(|v| v.checked_mul(p))
                .is_none_or(|v| v > 250_000_000)
        {
            return Err(ProviderError("KNN_SHAPE_OR_WORK_BUDGET_EXCEEDED".into()));
        }
        let qv = MatrixView::new(&mut query, n, p);
        let rv = MatrixView::new(&mut reference, nr, p);
        let mut indices = vec![-1i64; n * k];
        let mut distances = vec![f64::NAN; n * k];
        self.check(unsafe {
            (self.knn_fn)(
                self.context,
                &qv,
                &rv,
                r.query_group_ids.as_ptr(),
                r.reference_group_ids.as_ptr(),
                k as i32,
                indices.as_mut_ptr(),
                distances.as_mut_ptr(),
            )
        })?;
        Ok(NearestNeighborsDiagnostics {
            indices: indices.chunks(k).map(<[i64]>::to_vec).collect(),
            distances: distances
                .chunks(k)
                .map(|row| row.iter().map(|v| v.is_finite().then_some(*v)).collect())
                .collect(),
            backend_version: self.version.clone(),
        })
    }
    fn local_contrast(
        &self,
        r: &LocalContrastRequest,
    ) -> Result<LocalContrastDiagnostics, ProviderError> {
        let n = r.targets.len();
        let k = r.neighbor_indices.first().map_or(0, Vec::len);
        if n == 0
            || k == 0
            || k > 100
            || r.group_ids.len() != n
            || r.neighbor_indices.len() != n
            || r.neighbor_indices.iter().any(|row| row.len() != k)
            || n.checked_mul(n).is_none_or(|v| v > 250_000_000)
            || r.targets.iter().any(|v| !v.is_finite())
        {
            return Err(ProviderError("LOCAL_CONTRAST_SHAPE_OR_WORK_BUDGET".into()));
        }
        let indices: Vec<i64> = r.neighbor_indices.iter().flatten().copied().collect();
        let mut out = [f64::NAN; 4];
        self.check(unsafe {
            (self.local_fn)(
                self.context,
                r.targets.as_ptr(),
                indices.as_ptr(),
                r.group_ids.as_ptr(),
                n as i64,
                k as i32,
                i32::from(r.categorical),
                out.as_mut_ptr(),
            )
        })?;
        Ok(LocalContrastDiagnostics {
            contrast: out[0].is_finite().then_some(out[0]),
            fraction_rows_with_neighbors: out[1],
            observed_same_class_fraction: out[2].is_finite().then_some(out[2]),
            expected_same_class_fraction: out[3].is_finite().then_some(out[3]),
            backend_version: self.version.clone(),
        })
    }
    fn hdbscan(&self, r: &HdbscanRequest) -> Result<HdbscanDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        if n < 2
            || r.min_cluster_size < 2
            || r.min_samples == 0
            || r.min_samples > n
            || (n as f64) * (n as f64) * (p as f64) > 2.5e9
        {
            return Err(ProviderError("HDBSCAN_SHAPE_OR_WORK_BUDGET".into()));
        }
        let xv = MatrixView::new(&mut x, n, p);
        let mut labels = vec![0i64; n];
        let mut membership = vec![f64::NAN; n];
        let mut outlier = vec![f64::NAN; n];
        let mut persistence = vec![f64::NAN; n];
        let (mut parent, mut size, mut label) = (vec![0i64; n], vec![0i64; n], vec![0i64; n]);
        let (mut birth, mut death, mut stability) = (vec![0.; n], vec![0.; n], vec![0.; n]);
        let (mut n_clusters, mut n_nodes) = (0i64, 0i64);
        // SAFETY: every output holds n = X.rows elements, the documented capacity.
        self.check(unsafe {
            (self.hdbscan_fn)(
                self.context,
                &xv,
                r.min_cluster_size as i64,
                r.min_samples as i64,
                i32::from(r.selection == ClusterSelection::Leaf),
                i32::from(r.allow_single_cluster),
                labels.as_mut_ptr(),
                membership.as_mut_ptr(),
                outlier.as_mut_ptr(),
                &mut n_clusters,
                persistence.as_mut_ptr(),
                &mut n_nodes,
                parent.as_mut_ptr(),
                size.as_mut_ptr(),
                label.as_mut_ptr(),
                birth.as_mut_ptr(),
                death.as_mut_ptr(),
                stability.as_mut_ptr(),
            )
        })?;
        let (k, c) = (n_nodes as usize, n_clusters as usize);
        let tree = (0..k)
            .map(|j| HdbscanTreeNode {
                parent: usize::try_from(parent[j]).ok(),
                size: size[j].max(0) as usize,
                label: usize::try_from(label[j]).ok(),
                birth_distance: (parent[j] >= 0).then(|| 1.0 / birth[j]),
                death_distance: 1.0 / death[j],
                stability: stability[j].is_finite().then_some(stability[j]),
            })
            .collect();
        Ok(HdbscanDiagnostics {
            labels,
            membership,
            outlier_scores: outlier
                .iter()
                .map(|v| v.is_finite().then_some(*v))
                .collect(),
            persistence: persistence[..c].to_vec(),
            tree,
            backend_version: self.version.clone(),
        })
    }
    fn adjusted_rand_index(
        &self,
        r: &AdjustedRandRequest,
    ) -> Result<AdjustedRandDiagnostics, ProviderError> {
        if r.labels_a.len() != r.labels_b.len() || r.labels_a.len() > 10_000_000 {
            return Err(ProviderError("ARI_SHAPE_OR_WORK_BUDGET".into()));
        }
        let mut ari = f64::NAN;
        self.check(unsafe {
            (self.ari_fn)(
                self.context,
                r.labels_a.as_ptr(),
                r.labels_b.as_ptr(),
                r.labels_a.len() as i64,
                &mut ari,
            )
        })?;
        Ok(AdjustedRandDiagnostics {
            ari: ari.is_finite().then_some(ari),
            backend_version: self.version.clone(),
        })
    }
    fn snv(&self, r: &SnvRequest) -> Result<SnvDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        let mut out = vec![0.; n * p];
        let xv = MatrixView::new(&mut x, n, p);
        let ov = MatrixView::new(&mut out, n, p);
        let mut handle = std::ptr::null_mut();
        // SAFETY: Methods SNV with mean and population SD (ddof 0), the same
        // operator the WASM registry builds; the handle is destroyed below.
        let status = unsafe {
            let created = (self.snv_create)(&mut handle, 1, 1, 0);
            if created != 0 || handle.is_null() {
                created.max(1)
            } else {
                let status = (self.snv_transform)(handle, xv, ov);
                (self.snv_destroy)(handle);
                status
            }
        };
        if status != 0 {
            return Err(ProviderError(format!("METHODS_STATUS_{status}")));
        }
        Ok(SnvDiagnostics {
            matrix: out.chunks(p).map(<[f64]>::to_vec).collect(),
            backend_version: self.version.clone(),
        })
    }
    fn noise_proxy(&self, r: &NoiseProxyRequest) -> Result<NoiseProxyDiagnostics, ProviderError> {
        let n = r.matrix.len();
        let p = r.matrix.first().map_or(0, Vec::len);
        if r.valid_mask.len() != n
            || r.valid_mask.iter().any(|row| row.len() != p)
            || r.window_length > i32::MAX as usize
            || r.polyorder > i32::MAX as usize
        {
            return Err(ProviderError("INVALID_NOISE_PROXY_SHAPE".into()));
        }
        // Masked cells are never read by Methods; zero keeps the buffer finite.
        let masked: Vec<Vec<f64>> = r
            .matrix
            .iter()
            .zip(&r.valid_mask)
            .map(|(row, mask)| {
                row.iter()
                    .zip(mask)
                    .map(|(v, ok)| if *ok { *v } else { 0.0 })
                    .collect()
            })
            .collect();
        let (mut x, n, p) = flatten(&masked)?;
        let mask: Vec<u8> = r
            .valid_mask
            .iter()
            .flatten()
            .map(|v| u8::from(*v))
            .collect();
        let mut band = vec![f64::NAN; p];
        let mut counts = vec![0i64; p];
        let mut out = [f64::NAN; 2];
        let xv = MatrixView::new(&mut x, n, p);
        self.check(unsafe {
            (self.noise_fn)(
                self.context,
                &xv,
                mask.as_ptr(),
                r.window_length as i32,
                r.polyorder as i32,
                band.as_mut_ptr(),
                counts.as_mut_ptr(),
                out.as_mut_ptr(),
            )
        })?;
        Ok(NoiseProxyDiagnostics {
            band_noise: band
                .into_iter()
                .map(|v| v.is_finite().then_some(v))
                .collect(),
            band_counts: counts.into_iter().map(|v| v.max(0) as usize).collect(),
            pooled: out[0].is_finite().then_some(out[0]),
            residual_gain: out[1],
            backend_version: self.version.clone(),
        })
    }
    fn tolerance_pairs(
        &self,
        r: &TolerancePairsRequest,
    ) -> Result<TolerancePairsDiagnostics, ProviderError> {
        let (mut query, n, p) = flatten(&r.query)?;
        let mut reference = r.reference.as_deref().map(flatten).transpose()?;
        let nr = reference.as_ref().map_or(n, |(_, rows, _)| *rows);
        let work = match &reference {
            None => n.checked_mul(n.saturating_sub(1)).map(|v| v / 2),
            Some(_) => n.checked_mul(nr),
        }
        .and_then(|v| v.checked_mul(p));
        if reference.as_ref().is_some_and(|(_, _, pr)| *pr != p)
            || r.query_group_ids.len() != n
            || r.reference_group_ids.len() != if reference.is_some() { nr } else { 0 }
            || r.max_pairs > 1_000_000
            || work.is_none_or(|v| v > 250_000_000)
        {
            return Err(ProviderError(
                "TOLERANCE_PAIRS_SHAPE_OR_WORK_BUDGET_EXCEEDED".into(),
            ));
        }
        let qv = MatrixView::new(&mut query, n, p);
        let rv = reference
            .as_mut()
            .map(|(data, rows, cols)| MatrixView::new(data, *rows, *cols));
        let mut pairs = vec![0i64; 2 * r.max_pairs];
        let mut distances = vec![f64::NAN; r.max_pairs];
        let mut query_flags = vec![0u8; n];
        let mut reference_flags = vec![0u8; if rv.is_some() { nr } else { 0 }];
        let mut counts = [0i64; 2];
        self.check(unsafe {
            (self.pairs_fn)(
                self.context,
                &qv,
                rv.as_ref()
                    .map_or(std::ptr::null(), |v| v as *const MatrixView),
                r.query_group_ids.as_ptr(),
                if rv.is_some() {
                    r.reference_group_ids.as_ptr()
                } else {
                    std::ptr::null()
                },
                r.tolerance,
                r.max_pairs as i64,
                pairs.as_mut_ptr(),
                distances.as_mut_ptr(),
                query_flags.as_mut_ptr(),
                if rv.is_some() {
                    reference_flags.as_mut_ptr()
                } else {
                    std::ptr::null_mut()
                },
                counts.as_mut_ptr(),
            )
        })?;
        let total = counts[0].max(0) as usize;
        let listed = total.min(r.max_pairs);
        Ok(TolerancePairsDiagnostics {
            pairs: pairs[..2 * listed]
                .chunks(2)
                .map(|v| [v[0].max(0) as usize, v[1].max(0) as usize])
                .collect(),
            distances: distances[..listed].to_vec(),
            query_flags: query_flags.into_iter().map(|v| v != 0).collect(),
            reference_flags: reference_flags.into_iter().map(|v| v != 0).collect(),
            total_pairs: total,
            candidate_pairs: counts[1].max(0) as usize,
            backend_version: self.version.clone(),
        })
    }
}
