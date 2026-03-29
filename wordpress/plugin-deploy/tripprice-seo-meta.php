<?php
/**
 * Plugin Name: Tripprice SEO Meta
 * Plugin URI:  https://tripprice.net
 * Description: Yoast SEO 점수 필드(linkdex, content_score)를 WP REST API에 추가 노출합니다.
 *              focuskw/title/metadesc/canonical은 Yoast SEO 플러그인이 직접 등록하므로 여기서 제외.
 * Version:     1.2.0
 * Author:      Tripprice
 */

defined('ABSPATH') || exit;

add_action('rest_api_init', static function () {
    // Yoast가 자체 등록하지 않는 점수 필드만 추가 등록
    // _yoast_wpseo_focuskw / title / metadesc / canonical 은 Yoast 플러그인이 등록 — 중복 등록 시 충돌로 Gutenberg 사이드바에서 값이 사라짐
    $score_fields = [
        '_yoast_wpseo_linkdex'       => 10,   // SEO 점수 (1~100)
        '_yoast_wpseo_content_score' => 10,   // 가독성 점수 (1~100)
    ];

    foreach ($score_fields as $key => $maxLength) {
        // 이미 등록된 경우 스킵 (Yoast가 먼저 등록했을 수 있음)
        if (registered_meta_key_exists('post', $key)) continue;

        register_post_meta('post', $key, [
            'type'              => 'string',
            'single'            => true,
            'show_in_rest'      => [
                'schema' => ['type' => 'string', 'maxLength' => $maxLength],
            ],
            'default'           => '',
            'sanitize_callback' => 'sanitize_text_field',
            'auth_callback'     => static function ($allowed, $meta_key, $post_id) {
                return current_user_can('edit_post', $post_id);
            },
        ]);
    }
}, 20); // priority 20: Yoast(10) 완전히 초기화된 이후 실행
