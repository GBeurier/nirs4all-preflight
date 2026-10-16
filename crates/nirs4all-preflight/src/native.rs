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
type Association = unsafe extern "C" fn(
    *mut c_void,
    *const i64,
    *const f64,
    i64,
    i32,
    i32,
    u64,
    *mut f64,
    *mut i64,
) -> i32;
type PAdjust = unsafe extern "C" fn(*mut c_void, *const f64, i64, *mut f64) -> i32;
type Correlation = unsafe extern "C" fn(
    *mut c_void,
    *const f64,
    *const f64,
    i64,
    i32,
    i32,
    u64,
    *mut f64,
    *mut i64,
) -> i32;
type AssociationExact =
    unsafe extern "C" fn(*mut c_void, *const i64, *const f64, i64, i32, i64, *mut f64) -> i32;
type CorrelationExact =
    unsafe extern "C" fn(*mut c_void, *const f64, *const f64, i64, i32, i64, *mut f64) -> i32;
type Permanova = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    *const i64,
    i32,
    u64,
    *mut f64,
    *mut i64,
    *mut i32,
) -> i32;
type Permdisp = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    i32,
    u64,
    *mut f64,
    *mut f64,
    *mut f64,
    *mut i64,
    *mut i32,
) -> i32;
type Energy = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    i32,
    i32,
    u64,
    *mut f64,
    *mut f64,
    *mut f64,
    *mut f64,
    *mut i64,
) -> i32;
type PcaMonitor = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const MatrixView,
    i32,
    i32,
    f64,
    *mut f64,
    *mut f64,
    *mut f64,
    *mut f64,
    *mut f64,
    *mut i32,
    *mut i64,
    *mut f64,
) -> i32;
type FreedmanLane = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    *const i64,
    i32,
    i32,
    u64,
    *mut f64,
    *mut i64,
    *mut i32,
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
type VarianceReml = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    *const u8,
    *mut f64,
    *mut i32,
) -> i32;
type VarianceIntervals = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    *const i64,
    *const u8,
    f64,
    i32,
    u64,
    *mut f64,
    *mut i64,
) -> i32;
type GroupMeans = unsafe extern "C" fn(
    *mut c_void,
    *const MatrixView,
    *const i64,
    i64,
    *mut f64,
    *mut i64,
) -> i32;
type RegressionScoresFn =
    unsafe extern "C" fn(*mut c_void, *const f64, *const f64, i64, *mut f64) -> i32;

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
    association_fn: Association,
    holm_fn: PAdjust,
    correlation_fn: Correlation,
    bh_fn: PAdjust,
    association_exact_fn: AssociationExact,
    correlation_exact_fn: CorrelationExact,
    permanova_fn: Permanova,
    permdisp_fn: Permdisp,
    freedman_lane_fn: FreedmanLane,
    energy_fn: Energy,
    monitor_fn: PcaMonitor,
    reml_fn: VarianceReml,
    intervals_fn: VarianceIntervals,
    group_means_fn: GroupMeans,
    regression_scores_fn: RegressionScoresFn,
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
                .map_err(|_| ProviderError::unsupported("METHODS_LIBRARY_LOAD_FAILED"))?;
            let compat = *library
                .get::<unsafe extern "C" fn(u32, u32) -> i32>(b"n4m_check_abi_compatibility\0")
                .map_err(err)?;
            if compat(2, 20) != 0 {
                return Err(ProviderError::unsupported("METHODS_ABI_2_20_REQUIRED"));
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
            let association_fn = *library
                .get::<Association>(b"n4m_preflight_factor_association\0")
                .map_err(err)?;
            let holm_fn = *library
                .get::<PAdjust>(b"n4m_preflight_holm_adjust\0")
                .map_err(err)?;
            let correlation_fn = *library
                .get::<Correlation>(b"n4m_stats_correlation_test\0")
                .map_err(err)?;
            let bh_fn = *library
                .get::<PAdjust>(b"n4m_stats_bh_adjust\0")
                .map_err(err)?;
            let association_exact_fn = *library
                .get::<AssociationExact>(b"n4m_stats_factor_association_exact\0")
                .map_err(err)?;
            let correlation_exact_fn = *library
                .get::<CorrelationExact>(b"n4m_stats_correlation_exact\0")
                .map_err(err)?;
            let permanova_fn = *library
                .get::<Permanova>(b"n4m_stats_permanova\0")
                .map_err(err)?;
            let permdisp_fn = *library
                .get::<Permdisp>(b"n4m_stats_permdisp\0")
                .map_err(err)?;
            let freedman_lane_fn = *library
                .get::<FreedmanLane>(b"n4m_stats_permanova_freedman_lane\0")
                .map_err(err)?;
            let energy_fn = *library
                .get::<Energy>(b"n4m_stats_energy_distance\0")
                .map_err(err)?;
            let monitor_fn = *library
                .get::<PcaMonitor>(b"n4m_stats_pca_monitor\0")
                .map_err(err)?;
            let reml_fn = *library
                .get::<VarianceReml>(b"n4m_stats_variance_components_reml\0")
                .map_err(err)?;
            let intervals_fn = *library
                .get::<VarianceIntervals>(b"n4m_stats_variance_components_intervals\0")
                .map_err(err)?;
            let group_means_fn = *library
                .get::<GroupMeans>(b"n4m_stats_group_means\0")
                .map_err(err)?;
            let regression_scores_fn = *library
                .get::<RegressionScoresFn>(b"n4m_stats_regression_scores\0")
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
                return Err(ProviderError::internal("METHODS_CONTEXT_CREATE_FAILED"));
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
                association_fn,
                holm_fn,
                correlation_fn,
                bh_fn,
                association_exact_fn,
                correlation_exact_fn,
                permanova_fn,
                permdisp_fn,
                freedman_lane_fn,
                energy_fn,
                monitor_fn,
                reml_fn,
                intervals_fn,
                group_means_fn,
                regression_scores_fn,
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
        let message = unsafe {
            let p = (self.last_error)(self.context);
            if p.is_null() {
                String::new()
            } else {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        };
        Err(ProviderError::from_methods_error(status, &message))
    }
}
impl NativeMethodsProvider {
    fn exact(&self, out: [f64; 4]) -> ExactPermutationDiagnostics {
        let finite = |v: f64| v.is_finite().then_some(v);
        ExactPermutationDiagnostics {
            n_arrangements: out[0] as usize,
            p_value: finite(out[1]),
            minimum_p_value: finite(out[2]),
            maximum_statistic: finite(out[3]),
            backend_version: self.version.clone(),
        }
    }
}
fn err(_e: libloading::Error) -> ProviderError {
    ProviderError::unsupported("METHODS_LIBRARY_LOAD_FAILED")
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
        return Err(ProviderError::internal("INVALID_PROVIDER_MATRIX"));
    }
    if n.checked_mul(p).is_none_or(|cells| cells > 10_000_000) {
        return Err(ProviderError::unsupported(
            "PROVIDER_MEMORY_BUDGET_EXCEEDED",
        ));
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
                reason: Some(format!("Methods {} ABI 2.20; alpha protocol", self.version)),
            })
            .collect()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        let k = r.n_components;
        if k == 0 || k > n.min(p) || k > i32::MAX as usize {
            return Err(ProviderError::internal("INVALID_PCA_COMPONENTS"));
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
            return Err(ProviderError::internal("INVALID_REPEATABILITY_SHAPE"));
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
            return Err(ProviderError::internal("INVALID_SUMMARY_VALUES"));
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
            return Err(ProviderError::unsupported(
                "KNN_SHAPE_OR_WORK_BUDGET_EXCEEDED",
            ));
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
            return Err(ProviderError::unsupported(
                "LOCAL_CONTRAST_SHAPE_OR_WORK_BUDGET",
            ));
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
            return Err(ProviderError::unsupported("HDBSCAN_SHAPE_OR_WORK_BUDGET"));
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
            return Err(ProviderError::unsupported("ARI_SHAPE_OR_WORK_BUDGET"));
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
            return Err(ProviderError::from_methods_status(status));
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
            return Err(ProviderError::internal("INVALID_NOISE_PROXY_SHAPE"));
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
            return Err(ProviderError::unsupported(
                "TOLERANCE_PAIRS_SHAPE_OR_WORK_BUDGET_EXCEEDED",
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
    fn association(&self, r: &AssociationRequest) -> Result<AssociationDiagnostics, ProviderError> {
        let n = r.targets.len();
        if n < 2
            || r.factor_codes.len() != n
            || r.n_permutations > 1_000_000
            || r.targets.iter().any(|v| !v.is_finite())
        {
            return Err(ProviderError::internal("INVALID_ASSOCIATION_REQUEST"));
        }
        let mut out = [f64::NAN; 8];
        let mut counts = [0i64; 2];
        // SAFETY: input slices have n elements; outputs are owned fixed arrays.
        self.check(unsafe {
            (self.association_fn)(
                self.context,
                r.factor_codes.as_ptr(),
                r.targets.as_ptr(),
                n as i64,
                i32::from(r.categorical),
                r.n_permutations as i32,
                r.seed,
                out.as_mut_ptr(),
                counts.as_mut_ptr(),
            )
        })?;
        let finite = |v: f64| v.is_finite().then_some(v);
        Ok(AssociationDiagnostics {
            effect_size: finite(out[0]),
            statistic: finite(out[1]),
            df1: finite(out[2]),
            df2: finite(out[3]),
            n_levels: out[4] as usize,
            n_target_values: out[5] as usize,
            log10_distinct_permutations: out[6],
            p_value: finite(out[7]),
            n_at_least_observed: counts[0].max(0) as usize,
            n_permutations_executed: counts[1].max(0) as usize,
            backend_version: self.version.clone(),
        })
    }
    fn holm_adjust(&self, r: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        if r.p_values.is_empty() || r.p_values.iter().any(|p| !(0.0..=1.0).contains(p)) {
            return Err(ProviderError::internal("INVALID_HOLM_REQUEST"));
        }
        let mut adjusted = vec![f64::NAN; r.p_values.len()];
        // SAFETY: input and output buffers both hold m elements.
        self.check(unsafe {
            (self.holm_fn)(
                self.context,
                r.p_values.as_ptr(),
                r.p_values.len() as i64,
                adjusted.as_mut_ptr(),
            )
        })?;
        Ok(HolmDiagnostics {
            adjusted,
            backend_version: self.version.clone(),
        })
    }
    fn correlation(&self, r: &CorrelationRequest) -> Result<CorrelationDiagnostics, ProviderError> {
        let n = r.x.len();
        if n < 2
            || r.y.len() != n
            || r.n_permutations > 1_000_000
            || r.x.iter().chain(&r.y).any(|v| !v.is_finite())
        {
            return Err(ProviderError::internal("INVALID_CORRELATION_REQUEST"));
        }
        let method = match r.method {
            CorrelationMethod::Pearson => 0,
            CorrelationMethod::Spearman => 1,
        };
        let mut out = [f64::NAN; 5];
        let mut counts = [0i64; 2];
        // SAFETY: input slices have n elements; outputs are owned fixed arrays.
        self.check(unsafe {
            (self.correlation_fn)(
                self.context,
                r.x.as_ptr(),
                r.y.as_ptr(),
                n as i64,
                method,
                r.n_permutations as i32,
                r.seed,
                out.as_mut_ptr(),
                counts.as_mut_ptr(),
            )
        })?;
        let finite = |v: f64| v.is_finite().then_some(v);
        Ok(CorrelationDiagnostics {
            coefficient: finite(out[0]),
            n_distinct_x: out[1] as usize,
            n_distinct_y: out[2] as usize,
            log10_distinct_permutations: out[3],
            p_value: finite(out[4]),
            n_at_least_observed: counts[0].max(0) as usize,
            n_permutations_executed: counts[1].max(0) as usize,
            backend_version: self.version.clone(),
        })
    }
    fn association_exact(
        &self,
        r: &AssociationExactRequest,
    ) -> Result<ExactPermutationDiagnostics, ProviderError> {
        let n = r.targets.len();
        if n < 2
            || r.factor_codes.len() != n
            || !(1..=10_000_000).contains(&r.max_arrangements)
            || r.targets.iter().any(|v| !v.is_finite())
        {
            return Err(ProviderError::internal("INVALID_EXACT_PERMUTATION_REQUEST"));
        }
        let mut out = [f64::NAN; 4];
        // SAFETY: input slices have n elements; the output is an owned array.
        self.check(unsafe {
            (self.association_exact_fn)(
                self.context,
                r.factor_codes.as_ptr(),
                r.targets.as_ptr(),
                n as i64,
                i32::from(r.categorical),
                r.max_arrangements as i64,
                out.as_mut_ptr(),
            )
        })?;
        Ok(self.exact(out))
    }
    fn correlation_exact(
        &self,
        r: &CorrelationExactRequest,
    ) -> Result<ExactPermutationDiagnostics, ProviderError> {
        let n = r.x.len();
        if n < 2
            || r.y.len() != n
            || !(1..=10_000_000).contains(&r.max_arrangements)
            || r.x.iter().chain(&r.y).any(|v| !v.is_finite())
        {
            return Err(ProviderError::internal("INVALID_EXACT_PERMUTATION_REQUEST"));
        }
        let mut out = [f64::NAN; 4];
        // SAFETY: input slices have n elements; the output is an owned array.
        self.check(unsafe {
            (self.correlation_exact_fn)(
                self.context,
                r.x.as_ptr(),
                r.y.as_ptr(),
                n as i64,
                i32::from(r.method == CorrelationMethod::Spearman),
                r.max_arrangements as i64,
                out.as_mut_ptr(),
            )
        })?;
        Ok(self.exact(out))
    }
    fn bh_adjust(&self, r: &BhRequest) -> Result<BhDiagnostics, ProviderError> {
        if r.p_values.is_empty() || r.p_values.iter().any(|p| !(0.0..=1.0).contains(p)) {
            return Err(ProviderError::internal("INVALID_BH_REQUEST"));
        }
        let mut adjusted = vec![f64::NAN; r.p_values.len()];
        // SAFETY: input and output buffers both hold m elements.
        self.check(unsafe {
            (self.bh_fn)(
                self.context,
                r.p_values.as_ptr(),
                r.p_values.len() as i64,
                adjusted.as_mut_ptr(),
            )
        })?;
        Ok(BhDiagnostics {
            adjusted,
            backend_version: self.version.clone(),
        })
    }
    fn permanova(&self, r: &PermanovaRequest) -> Result<PermanovaDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        if n < 2
            || r.term_codes.len() != n
            || r.strata_codes.as_ref().is_some_and(|s| s.len() != n)
            || r.n_permutations > 1_000_000
        {
            return Err(ProviderError::internal("INVALID_PERMANOVA_REQUEST"));
        }
        let xv = MatrixView::new(&mut x, n, p);
        let mut out = [f64::NAN; 15];
        let mut counts = [0i64; 2];
        let mut exponent = 0i32;
        // SAFETY: the view owns n x p values; code arrays hold n elements;
        // outputs are owned fixed arrays of the documented sizes.
        self.check(unsafe {
            (self.permanova_fn)(
                self.context,
                &xv,
                r.term_codes.as_ptr(),
                r.strata_codes
                    .as_ref()
                    .map_or(std::ptr::null(), |s| s.as_ptr()),
                r.n_permutations as i32,
                r.seed,
                out.as_mut_ptr(),
                counts.as_mut_ptr(),
                &mut exponent,
            )
        })?;
        let finite = |v: f64| v.is_finite().then_some(v);
        Ok(PermanovaDiagnostics {
            ss_binary_exponent: exponent,
            ss_total: out[0],
            ss_strata: out[1],
            ss_term: out[2],
            ss_residual: out[3],
            r2: finite(out[4]),
            partial_r2: finite(out[5]),
            pseudo_f: finite(out[6]),
            df_term: out[7] as usize,
            df_residual: out[8] as usize,
            n_levels: out[9] as usize,
            n_strata: out[10] as usize,
            log10_distinct_permutations: out[11],
            p_value: finite(out[12]),
            residual_resolution: finite(out[13]),
            f_numerically_unresolved: out[14] == 1.0,
            n_at_least_observed: counts[0].max(0) as usize,
            n_permutations_executed: counts[1].max(0) as usize,
            backend_version: self.version.clone(),
        })
    }
    fn group_means(&self, r: &GroupMeansRequest) -> Result<GroupMeansDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        let g = r.n_groups;
        if g == 0
            || g > n
            || r.group_codes.len() != n
            || r.group_codes.iter().any(|&c| c < 0 || c as usize >= g)
        {
            return Err(ProviderError::internal("INVALID_GROUP_MEANS_REQUEST"));
        }
        let xv = MatrixView::new(&mut x, n, p);
        let mut means = vec![f64::NAN; g * p];
        let mut counts = vec![0i64; g];
        // SAFETY: the view owns n x p values; outputs hold g x p and g values.
        self.check(unsafe {
            (self.group_means_fn)(
                self.context,
                &xv,
                r.group_codes.as_ptr(),
                g as i64,
                means.as_mut_ptr(),
                counts.as_mut_ptr(),
            )
        })?;
        Ok(GroupMeansDiagnostics {
            means: means.chunks(p).map(<[f64]>::to_vec).collect(),
            counts: counts.into_iter().map(|c| c.max(0) as usize).collect(),
            backend_version: self.version.clone(),
        })
    }
    fn regression_scores(
        &self,
        r: &RegressionScoresRequest,
    ) -> Result<RegressionScores, ProviderError> {
        let n = r.y_true.len();
        if n == 0
            || n != r.y_pred.len()
            || n > 10_000_000
            || r.y_true.iter().chain(&r.y_pred).any(|v| !v.is_finite())
        {
            return Err(ProviderError::internal("INVALID_REGRESSION_SCORES_REQUEST"));
        }
        let mut out = [f64::NAN; 3];
        // SAFETY: both inputs hold n finite values; out holds three doubles.
        self.check(unsafe {
            (self.regression_scores_fn)(
                self.context,
                r.y_true.as_ptr(),
                r.y_pred.as_ptr(),
                n as i64,
                out.as_mut_ptr(),
            )
        })?;
        Ok(RegressionScores {
            rmse: out[0],
            mae: out[1],
            r2: out[2].is_finite().then_some(out[2]),
            backend_version: self.version.clone(),
        })
    }
    fn permdisp(&self, r: &PermdispRequest) -> Result<PermdispDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        if n < 2 || r.group_codes.len() != n || r.n_permutations > 1_000_000 {
            return Err(ProviderError::internal("INVALID_PERMDISP_REQUEST"));
        }
        let xv = MatrixView::new(&mut x, n, p);
        let mut distances = vec![f64::NAN; n];
        let mut means = vec![f64::NAN; n];
        let mut out = [f64::NAN; 8];
        let mut counts = [0i64; 2];
        let mut exponent = 0i32;
        // SAFETY: the view owns n x p values; per-row outputs hold n values.
        self.check(unsafe {
            (self.permdisp_fn)(
                self.context,
                &xv,
                r.group_codes.as_ptr(),
                r.n_permutations as i32,
                r.seed,
                distances.as_mut_ptr(),
                means.as_mut_ptr(),
                out.as_mut_ptr(),
                counts.as_mut_ptr(),
                &mut exponent,
            )
        })?;
        let groups = (out[3] as usize).min(n);
        means.truncate(groups);
        Ok(PermdispDiagnostics {
            distance_binary_exponent: exponent,
            distances,
            group_mean_distances: means,
            f: out[0].is_finite().then_some(out[0]),
            df1: out[1] as usize,
            df2: out[2] as usize,
            n_groups: groups,
            log10_distinct_permutations: out[4],
            p_value: out[5].is_finite().then_some(out[5]),
            residual_resolution: out[6].is_finite().then_some(out[6]),
            f_numerically_unresolved: out[7] == 1.0,
            n_at_least_observed: counts[0].max(0) as usize,
            n_permutations_executed: counts[1].max(0) as usize,
            backend_version: self.version.clone(),
        })
    }
    fn permanova_freedman_lane(
        &self,
        r: &FreedmanLaneRequest,
    ) -> Result<FreedmanLaneDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        let c = r.condition_codes.len();
        if n < 2
            || r.term_codes.len() != n
            || c > 64
            || r.condition_codes.iter().any(|codes| codes.len() != n)
            || r.n_permutations > 1_000_000
        {
            return Err(ProviderError::internal("INVALID_FREEDMAN_LANE_REQUEST"));
        }
        let conditions: Vec<i64> = (0..n)
            .flat_map(|i| r.condition_codes.iter().map(move |codes| codes[i]))
            .collect();
        let xv = MatrixView::new(&mut x, n, p);
        let mut out = [f64::NAN; 14];
        let mut counts = [0i64; 2];
        let mut exponent = 0i32;
        // SAFETY: the view owns n x p values; term codes hold n and the
        // row-major condition codes n x c elements; outputs are fixed arrays.
        self.check(unsafe {
            (self.freedman_lane_fn)(
                self.context,
                &xv,
                r.term_codes.as_ptr(),
                if c == 0 {
                    std::ptr::null()
                } else {
                    conditions.as_ptr()
                },
                c as i32,
                r.n_permutations as i32,
                r.seed,
                out.as_mut_ptr(),
                counts.as_mut_ptr(),
                &mut exponent,
            )
        })?;
        let finite = |v: f64| v.is_finite().then_some(v);
        Ok(FreedmanLaneDiagnostics {
            ss_binary_exponent: exponent,
            ss_total: out[0],
            ss_reduced: out[1],
            ss_term: out[2],
            ss_residual: out[3],
            r2: finite(out[4]),
            partial_r2: finite(out[5]),
            pseudo_f: finite(out[6]),
            df_term: out[7] as usize,
            df_residual: out[8] as usize,
            rank_reduced: out[9] as usize,
            log10_distinct_permutations: out[10],
            p_value: finite(out[11]),
            residual_resolution: finite(out[12]),
            f_numerically_unresolved: out[13] == 1.0,
            n_at_least_observed: counts[0].max(0) as usize,
            n_permutations_executed: counts[1].max(0) as usize,
            backend_version: self.version.clone(),
        })
    }
    fn energy_distance(
        &self,
        r: &EnergyDistanceRequest,
    ) -> Result<EnergyDistanceDiagnostics, ProviderError> {
        let n = r.matrix.len();
        let p = r.matrix.first().map_or(0, Vec::len);
        let g = r.n_groups;
        if r.group_codes.len() != n
            || g < 2
            || g > n
            || r.n_permutations > 1_000_000
            || r.group_codes.iter().any(|&c| c < 0 || c as usize >= g)
        {
            return Err(ProviderError::internal("INVALID_ENERGY_DISTANCE_REQUEST"));
        }
        // The Methods budgets, checked here before any allocation (the g x g
        // outputs included), with checked products.
        let pairs = n.checked_mul(n - 1).map(|v| v / 2);
        let within = |v: Option<usize>, limit: usize| v.is_some_and(|v| v <= limit);
        let work = pairs.and_then(|q| q.checked_mul(p.checked_add(r.n_permutations)? + 1));
        if !(within(pairs, 20_000_000)
            && within(n.checked_mul(p), 10_000_000)
            && within(g.checked_mul(g), 10_000_000)
            && within(work, 2_500_000_000))
        {
            return Err(ProviderError::unsupported("ENERGY_DISTANCE_WORK_BUDGET"));
        }
        let (mut x, _, _) = flatten(&r.matrix)?;
        let xv = MatrixView::new(&mut x, n, p);
        let mut energy = vec![f64::NAN; g * g];
        let mut bounds = vec![f64::NAN; g * g];
        let mut mean = vec![f64::NAN; g * g];
        let mut out = [f64::NAN; 5];
        let mut counts = [0i64; 3];
        // SAFETY: X is an owned n x p buffer, codes hold n elements and the
        // outputs hold g x g (three), 5 and 3 elements as documented.
        self.check(unsafe {
            (self.energy_fn)(
                self.context,
                &xv,
                r.group_codes.as_ptr(),
                g as i32,
                r.n_permutations as i32,
                r.seed,
                energy.as_mut_ptr(),
                bounds.as_mut_ptr(),
                mean.as_mut_ptr(),
                out.as_mut_ptr(),
                counts.as_mut_ptr(),
            )
        })?;
        let rows = |v: &[f64]| v.chunks(g).map(<[f64]>::to_vec).collect();
        Ok(EnergyDistanceDiagnostics {
            energy: rows(&energy),
            energy_bounds: rows(&bounds),
            mean_distances: rows(&mean),
            statistic: out[0],
            statistic_bound: out[1],
            log10_distinct_permutations: out[2],
            p_value: out[3].is_finite().then_some(out[3]),
            p_value_conservative: out[4].is_finite().then_some(out[4]),
            n_at_least_observed: counts[0].max(0) as usize,
            n_permutations_executed: counts[1].max(0) as usize,
            n_undecidable: counts[2].max(0) as usize,
            backend_version: self.version.clone(),
        })
    }
    fn pca_monitor(&self, r: &PcaMonitorRequest) -> Result<PcaMonitorDiagnostics, ProviderError> {
        let (n_r, n_m) = (r.reference.len(), r.monitored.len());
        let p = r.reference.first().map_or(0, Vec::len);
        let k = r.max_components;
        if k == 0 || k > p || r.n_folds < 2 || r.n_folds > n_r || k > i32::MAX as usize {
            return Err(ProviderError::internal("INVALID_PCA_MONITOR_REQUEST"));
        }
        let cells = n_r.checked_add(n_m).and_then(|rows| rows.checked_mul(p));
        if cells.is_none_or(|c| c > 10_000_000) {
            return Err(ProviderError::unsupported("PCA_MONITOR_WORK_BUDGET"));
        }
        let (mut reference, _, _) = flatten(&r.reference)?;
        let (mut monitored, _, p_m) = flatten(&r.monitored)?;
        if p_m != p {
            return Err(ProviderError::internal("INVALID_PCA_MONITOR_REQUEST"));
        }
        let rv = MatrixView::new(&mut reference, n_r, p);
        let mv = MatrixView::new(&mut monitored, n_m, p);
        let mut eigen = vec![f64::NAN; k];
        let (mut rt, mut rq) = (vec![f64::NAN; n_r], vec![f64::NAN; n_r]);
        let (mut mt, mut mq) = (vec![f64::NAN; n_m], vec![f64::NAN; n_m]);
        let mut effective = 0i32;
        let mut counts = [0i64; 6];
        let mut out = [f64::NAN; 13];
        // SAFETY: both views own their buffers; outputs hold k, n_r, n_m, 1, 6
        // and 13 elements as documented.
        self.check(unsafe {
            (self.monitor_fn)(
                self.context,
                &rv,
                &mv,
                k as i32,
                r.n_folds as i32,
                r.alpha,
                eigen.as_mut_ptr(),
                rt.as_mut_ptr(),
                rq.as_mut_ptr(),
                mt.as_mut_ptr(),
                mq.as_mut_ptr(),
                &mut effective,
                counts.as_mut_ptr(),
                out.as_mut_ptr(),
            )
        })?;
        let finite = |v: f64| v.is_finite().then_some(v);
        let effective = effective.max(0) as usize;
        eigen.truncate(effective);
        Ok(PcaMonitorDiagnostics {
            effective_components: effective,
            eigenvalues: eigen,
            reference_t2: rt.into_iter().map(finite).collect(),
            reference_q: rq,
            monitored_t2: mt.into_iter().map(finite).collect(),
            monitored_q: mq,
            t2_limit: finite(out[0]),
            q_limit: out[1],
            tolerance: out[9],
            condition: out[10],
            q_tolerance_scale: out[11],
            eigenvalue_resolution: out[12],
            n_beyond_t2: counts[0].max(0) as usize,
            n_beyond_q: counts[1].max(0) as usize,
            n_beyond_either: counts[2].max(0) as usize,
            n_near_t2: counts[3].max(0) as usize,
            n_near_q: counts[4].max(0) as usize,
            n_near_either: counts[5].max(0) as usize,
            reference_total_variance: out[2],
            monitored_total_variance: finite(out[3]),
            centroid_distance: out[4],
            centroid_subspace_distance: out[5],
            centroid_residual_distance: out[6],
            centroid_t2: finite(out[7]),
            retained_fraction: finite(out[8]),
            backend_version: self.version.clone(),
        })
    }
    fn variance_components(
        &self,
        r: &VarianceComponentsRequest,
    ) -> Result<VarianceComponentsDiagnostics, ProviderError> {
        let (mut x, n, p) = flatten(&r.matrix)?;
        if r.group_ids.len() != n
            || r.cluster_ids.as_ref().is_some_and(|c| c.len() != n)
            || r.valid_mask.len() != n
            || r.valid_mask.iter().any(|row| row.len() != p)
            || !(r.confidence > 0.0 && r.confidence < 1.0)
            || r.n_bootstrap > 100_000
        {
            return Err(ProviderError::internal(
                "INVALID_VARIANCE_COMPONENTS_REQUEST",
            ));
        }
        let mask: Vec<u8> = r
            .valid_mask
            .iter()
            .flatten()
            .map(|v| u8::from(*v))
            .collect();
        let mut point = vec![f64::NAN; 8 * p];
        let mut status = vec![0i32; p];
        let mut intervals = vec![f64::NAN; 8 * p];
        let mut valid = vec![0i64; p];
        let xv = MatrixView::new(&mut x, n, p);
        // SAFETY: inputs hold n (or n x p) elements; outputs hold 8p, p values.
        self.check(unsafe {
            (self.reml_fn)(
                self.context,
                &xv,
                r.group_ids.as_ptr(),
                mask.as_ptr(),
                point.as_mut_ptr(),
                status.as_mut_ptr(),
            )
        })?;
        self.check(unsafe {
            (self.intervals_fn)(
                self.context,
                &xv,
                r.group_ids.as_ptr(),
                r.cluster_ids
                    .as_ref()
                    .map_or(std::ptr::null(), |c| c.as_ptr()),
                mask.as_ptr(),
                r.confidence,
                r.n_bootstrap as i32,
                r.seed,
                intervals.as_mut_ptr(),
                valid.as_mut_ptr(),
            )
        })?;
        let finite = |v: f64| v.is_finite().then_some(v);
        let field = |k: usize| (0..p).map(|j| finite(point[8 * j + k])).collect();
        let count = |k: usize| (0..p).map(|j| point[8 * j + k].max(0.0) as usize).collect();
        let pair = |k: usize| {
            (0..p)
                .map(|j| {
                    [
                        finite(intervals[8 * j + k]),
                        finite(intervals[8 * j + k + 1]),
                    ]
                })
                .collect()
        };
        Ok(VarianceComponentsDiagnostics {
            sigma2_between: field(0),
            sigma2_within: field(1),
            icc: field(2),
            reml_log_likelihood: field(3),
            n_groups: count(4),
            n_observations: count(5),
            reml_candidates: count(6),
            bisection_iterations: count(7),
            status,
            sd_ci_chi_square: pair(0),
            icc_ci_exact_f: pair(2),
            sd_ci_bootstrap: pair(4),
            icc_ci_bootstrap: pair(6),
            n_valid_replicates: valid.into_iter().map(|v| v.max(0) as usize).collect(),
            backend_version: self.version.clone(),
        })
    }
}
