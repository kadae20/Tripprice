<?php
/**
 * Tripprice — Yoast SEO meta 필드 REST API 노출
 *
 * 배포:
 *   이 파일을 WordPress 서버의 wp-content/mu-plugins/tripprice-seo-meta.php 에 복사.
 *   mu-plugins는 플러그인 활성화 없이 자동 실행됨.
 *
 * 효과:
 *   _yoast_wpseo_focuskw / _yoast_wpseo_title / _yoast_wpseo_metadesc / _yoast_wpseo_canonical
 *   _yoast_wpseo_linkdex (SEO 점수) / _yoast_wpseo_content_score (가독성 점수) 를
 *   WP REST API meta 필드로 등록 → wp-publish.js가 보내는 값이 실제 저장됨.
 *   linkdex/content_score 초기값(50)을 API로 주입하면 관리자 목록에서 "사용불가" 대신 주황 표시.
 *
 * 확인:
 *   GET /wp-json/wp/v2/posts/{id}?context=edit 응답의 meta 키 목록에 6개가 나타나면 배포 성공.
 */

defined('ABSPATH') || exit;

add_action('rest_api_init', static function () {
    // 키별 스키마 및 sanitize 설정
    $meta_config = [
        '_yoast_wpseo_focuskw'      => ['maxLength' => 100,  'sanitize' => 'sanitize_text_field'],
        '_yoast_wpseo_title'        => ['maxLength' => 100,  'sanitize' => 'sanitize_text_field'],
        '_yoast_wpseo_metadesc'     => ['maxLength' => 300,  'sanitize' => 'sanitize_text_field'],
        '_yoast_wpseo_canonical'    => ['maxLength' => 2083, 'sanitize' => 'esc_url_raw'],
        '_yoast_wpseo_linkdex'      => ['maxLength' => 10,   'sanitize' => 'sanitize_text_field'],  // SEO 점수 (1~100)
        '_yoast_wpseo_content_score'=> ['maxLength' => 10,   'sanitize' => 'sanitize_text_field'],  // 가독성 점수 (1~100)
    ];

    foreach ($meta_config as $key => $cfg) {
        register_post_meta('post', $key, [
            'type'              => 'string',
            'single'            => true,
            'show_in_rest'      => [
                'schema' => [
                    'type'      => 'string',
                    'maxLength' => $cfg['maxLength'],
                ],
            ],
            'default'           => '',
            'sanitize_callback' => $cfg['sanitize'],
            // $post_id를 받아 해당 글에 대한 편집 권한 체크 (전역 edit_posts 아님)
            'auth_callback'     => static function ( $allowed, $meta_key, $post_id ) {
                return current_user_can( 'edit_post', $post_id );
            },
        ]);
    }
}, 11); // priority 11: Yoast 자체 init(10) 이후 실행
