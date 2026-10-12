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
    assert not any(c['available'] for c in report['capabilities'] if c['capability_id'] == 'validation_probe')


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
