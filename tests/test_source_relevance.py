"""Deterministic relevance gate tests for fetched scholarly rows."""

import sources


FALLING_BALL = (
    "Ek 2 kg ka gola 20 meter ooncha se girta hai hawa ka resistance ignore karo "
    "zameen se takrane ki speed, girne ka time, kinetic energy aur hawa resistance"
)


def test_unrelated_arxiv_titles_are_dropped_for_falling_ball():
    bad = [
        {
            "provider": "arxiv",
            "title": "The chromospheric magnetic field in active regions derived from spectropolarimetry of Ca II 8542",
            "note": "solar magnetic field and spectropolarimetric observations",
        },
        {
            "provider": "arxiv",
            "title": "A comprehensive study of distribution laws for the fragments of Košice meteorite",
            "note": "fragment distribution after meteorite fall",
        },
    ]
    assert all(not sources.is_relevant_source(FALLING_BALL, row) for row in bad)


def test_free_fall_air_resistance_title_is_kept():
    row = {
        "provider": "arxiv",
        "title": "Free fall and air resistance of a sphere",
        "abstract": "A physics treatment of falling spheres, impact speed and kinetic energy.",
    }
    assert sources.is_relevant_source(FALLING_BALL, row)
    assert sources.relevance_score(FALLING_BALL, row) >= 2


def test_generic_words_alone_do_not_pass_the_gate():
    row = {"title": "A comprehensive study of field distribution and analysis"}
    assert not sources.is_relevant_source("Explain the falling speed and kinetic energy of a ball", row)
