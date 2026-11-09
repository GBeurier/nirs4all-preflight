import json
from pathlib import Path

import pytest
from nirs4all_preflight import analyze, report_html, validate

FIXTURE = Path(__file__).resolve().parents[3] / 'examples/first_run.json'


def test_actual_methods_provider_and_reserved_test_exclusion():
    data = json.loads(FIXTURE.read_text())
    assert validate(data)['valid']
    report = analyze(data)
    assert report['profile_status'] == 'exploratory'
    metric = {m['metric_id']: m for m in report['metrics']}
    assert metric['population.development_real_samples']['value'] == 5
    assert metric['structure.effective_dimension']['status'] == 'computed'
    assert metric['target.continuous_distribution']['value']['count'] == 5
    assert '<!doctype html>' in report_html(report)
    probe = next(c for c in report['capabilities'] if c['capability_id'] == 'validation_probe')
    assert probe['available'] and not probe['qualified']


def test_input_nan_fails_before_crossing_ffi():
    data = json.loads(FIXTURE.read_text())
    data['sources'][0]['x'][0][0] = float('nan')
    with pytest.raises(ValueError):
        analyze(data)


def test_alias_leakage_cannot_enter_numerical_analysis():
    data = json.loads(FIXTURE.read_text())
    data['samples'][-1]['physical_sample_id'] = data['samples'][0]['physical_sample_id']
    report = analyze(data)
    assert report['status'] == 'failed'
    assert not report['metrics']
    assert any(i['code'] == 'IDENTITY_LEAKAGE' for i in report['validation']['issues'])


def test_installed_methods_path_and_no_overrides(monkeypatch):
    import os
    import sys
    import n4m
    import nirs4all_preflight

    assert not any(os.environ.get(key) for key in ("N4PF_LIBRARY_PATH", "N4M_LIBRARY_PATH", "N4M_LIB_PATH"))
    assert Path(nirs4all_preflight.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
    path = Path(n4m.library_path()).resolve()
    assert path.is_file() and path.is_relative_to(Path(sys.prefix).resolve())
    print(f"Installed Methods library: {path}")
    captured = []
    original = nirs4all_preflight._call

    def observe(name, payload, methods_library=None):
        if name == "n4pf_analyze_json":
            captured.append(methods_library)
        return original(name, payload, methods_library)

    monkeypatch.setattr(nirs4all_preflight, "_call", observe)
    report = analyze(json.loads(FIXTURE.read_text()))
    assert Path(captured[0]).resolve() == path
    assert next(m for m in report["metrics"] if m["metric_id"] == "structure.effective_dimension")["status"] == "computed"
